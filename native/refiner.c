/* Aura Camera 0.4.2. RGB guided filter, port of core.js RGBRefiner.
 * No dependencies, no imports, no I/O. Each instance has private session memory.
 * Reproducible build: python3 native/build.py (clang/wasm-ld required for rebuilding only).
 * Spatial reconstruction is unchanged. Optional RGB-gated 3-frame temporal guard follows the JS reference.
 */
#include <stdint.h>
#include <stddef.h>
extern unsigned char __heap_base;
__attribute__((visibility("default"))) uintptr_t heap_base(void) { return (uintptr_t)&__heap_base; }
__attribute__((visibility("default"))) int refiner_abi(void) { return 2; }
void *memset(void *p, int c, size_t n) { unsigned char *d=p; for(size_t i=0;i<n;i++)d[i]=(unsigned char)c; return p; }
void *memcpy(void *d, const void *s, size_t n) { unsigned char *a=d; const unsigned char *b=s; for(size_t i=0;i<n;i++)a[i]=b[i]; return d; }
static inline int min(int a,int b){return a<b?a:b;}
static inline int max(int a,int b){return a>b?a:b;}
static inline double unit(double x){return !__builtin_isfinite(x)||x<0?0:x>1?1:x;}
static inline double smooth(double lo,double hi,double x){x=unit((x-lo)/(hi-lo));return x*x*(3-2*x);}
static inline double absd(double a){return a<0?-a:a;}
static inline double sample(const float *a,int w,int h,double x,double y){
  x=x<0?0:x>w-1?w-1:x;y=y<0?0:y>h-1?h-1:y;
  int x0=(int)x,y0=(int)y,x1=min(w-1,x0+1),y1=min(h-1,y0+1);
  double fx=x-x0,fy=y-y0;
  return ((double)a[y0*w+x0]*(1-fx)+a[y0*w+x1]*fx)*(1-fy)+((double)a[y1*w+x0]*(1-fx)+a[y1*w+x1]*fx)*fy;
}
static void box_mean(const float *src,float *out,float *tmp,int w,int h,int r){
  for(int y=0;y<h;y++){
    int o=y*w;double sum=0;
    for(int k=0;k<=min(r,w-1);k++)sum+=src[o+k];
    for(int x=0;x<w;x++){
      out[o+x]=sum/(min(w-1,x+r)-max(0,x-r)+1);
      if(x-r>=0)sum-=src[o+x-r];if(x+r+1<w)sum+=src[o+x+r+1];
    }
  }
  for(int x=0;x<w;x++){
    double sum=0;for(int k=0;k<=min(r,h-1);k++)sum+=out[k*w+x];
    for(int y=0;y<h;y++){
      tmp[y*w+x]=sum/(min(h-1,y+r)-max(0,y-r)+1);
      if(y-r>=0)sum-=out[(y-r)*w+x];if(y+r+1<h)sum+=out[(y+r+1)*w+x];
    }
  }
  for(int i=0;i<w*h;i++)out[i]=tmp[i];
}
/* scratch: 27*gw*gh + 3*w floats. previousRGB: 3*w*h; previous/alpha: w*h.
 * rgba: 4*w*h bytes. mask: mw*mh floats. full/guide: 4*width*height bytes.
 * Inputs must be validated in the JS wrapper. */
__attribute__((visibility("default"))) void refine(
  const float *mask,int mw,int mh,const unsigned char *full,int w,int h,
  const unsigned char *guide,int gw,int gh,int edge,double threshold,double temporal,
  int matting,int history,float *scratch,float *previous,float *previousRGB,float *alpha,unsigned char *rgba,
  int guard,double retention,double medianWeight,float *raw1,float *raw2,float *age){
  int n=gw*gh,r=min(edge,min(gw-1,gh-1));
  float *p=scratch,*I[3],*means[3];int k=1;
  for(int c=0;c<3;c++)I[c]=scratch+(k++)*n;
  for(int c=0;c<3;c++)means[c]=scratch+(k++)*n;
  float *tmp=scratch+(k++)*n,*product=scratch+(k++)*n,*mp=scratch+(k++)*n;
  float *cov[6],*ip[3],*coeff[4],*avg[4];
  for(int c=0;c<6;c++)cov[c]=scratch+(k++)*n;
  for(int c=0;c<3;c++)ip[c]=scratch+(k++)*n;
  for(int c=0;c<4;c++)coeff[c]=scratch+(k++)*n;
  for(int c=0;c<4;c++)avg[c]=scratch+(k++)*n;
  for(int y=0;y<gh;y++)for(int x=0;x<gw;x++){
    int i=y*gw+x;
    /* Round resampling to f32 before thresholding, just like JS typed arrays. */
    float a=(mw==gw&&mh==gh)?mask[i]:sample(mask,mw,mh,(x+.5)*mw/gw-.5,(y+.5)*mh/gh-.5);
    p[i]=matting?unit(a):smooth(threshold-.18,threshold+.18,a);
    for(int c=0;c<3;c++)I[c][i]=guide[4*i+c]/255.0;
  }
  for(int c=0;c<3;c++)box_mean(I[c],means[c],tmp,gw,gh,r);
  box_mean(p,mp,tmp,gw,gh,r);
  const int pa[6]={0,0,0,1,1,2},pb[6]={0,1,2,1,2,2};
  for(int c=0;c<6;c++){
    int a=pa[c],b=pb[c];
    for(int i=0;i<n;i++)product[i]=(double)I[a][i]*I[b][i];
    box_mean(product,cov[c],tmp,gw,gh,r);
    for(int i=0;i<n;i++)cov[c][i]-=(double)means[a][i]*means[b][i];
  }
  for(int c=0;c<3;c++){
    for(int i=0;i<n;i++)product[i]=(double)I[c][i]*p[i];
    box_mean(product,ip[c],tmp,gw,gh,r);
    for(int i=0;i<n;i++)ip[c][i]-=(double)means[c][i]*mp[i];
  }
  for(int i=0;i<n;i++){
    double A=cov[0][i]+.0025,B=cov[1][i],C0=cov[2][i],D=cov[3][i]+.0025,E=cov[4][i],F=cov[5][i]+.0025;
    double aa=D*F-E*E,ab=C0*E-B*F,ac=B*E-C0*D,dd=A*F-C0*C0,de=B*C0-A*E,ff=A*D-B*B;
    double det=A*aa+B*ab+C0*ac;det=det<1e-12?1e-12:det;
    double u=ip[0][i],v=ip[1][i],z=ip[2][i];
    coeff[0][i]=(aa*u+ab*v+ac*z)/det;coeff[1][i]=(ab*u+dd*v+de*z)/det;coeff[2][i]=(ac*u+de*v+ff*z)/det;
    coeff[3][i]=mp[i]-(double)coeff[0][i]*means[0][i]-(double)coeff[1][i]*means[1][i]-(double)coeff[2][i]*means[2][i];
  }
  for(int c=0;c<4;c++)box_mean(coeff[c],avg[c],tmp,gw,gh,r);
  double shift=matting?(threshold-.5)*.35:0;
  float *xs=scratch+27*n,*xt=xs+w,*xf=xt+w;
  for(int x=0;x<w;x++){
    double gx=(x+.5)*gw/w-.5;gx=gx<0?0:gx>gw-1?gw-1:gx;
    int x0=(int)gx;xs[x]=x0;xt[x]=min(gw-1,x0+1);xf[x]=gx-x0;
  }
  for(int y=0;y<h;y++){
    double gy=(y+.5)*gh/h-.5;gy=gy<0?0:gy>gh-1?gh-1:gy;
    int y0=(int)gy,y1=min(gh-1,y0+1),o0=y0*gw,o1=y1*gw;double fy=gy-y0;
    for(int x=0;x<w;x++){
      int x0=(int)xs[x],x1=(int)xt[x];double fx=xf[x];
      int i=y*w+x,j=i*4,t3=i*3,u=o0+x0,v=o0+x1,z=o1+x0,t=o1+x1;
      double w0=(1-fx)*(1-fy),w1=fx*(1-fy),w2=(1-fx)*fy,w3=fx*fy;
      double base=p[u]*w0+p[v]*w1+p[z]*w2+p[t]*w3;
      double R=full[j]/255.0,G=full[j+1]/255.0,B=full[j+2]/255.0,a;
      if(base>.9999)a=1;
      else if(base<.0001)a=0;
      else{
        double q=(avg[0][u]*w0+avg[0][v]*w1+avg[0][z]*w2+avg[0][t]*w3)*R
                +(avg[1][u]*w0+avg[1][v]*w1+avg[1][z]*w2+avg[1][t]*w3)*G
                +(avg[2][u]*w0+avg[2][v]*w1+avg[2][z]*w2+avg[2][t]*w3)*B
                +(avg[3][u]*w0+avg[3][v]*w1+avg[3][z]*w2+avg[3][t]*w3);
        a=unit(.9*q+.1*base-shift);
        if(base>.998&&a>.975)a=1;if(base<.002&&a<.025)a=0;
      }
      if(guard){
        double candidate=a;
        if(history&&temporal>0){
          double change=(absd(R-previousRGB[t3])+absd(G-previousRGB[t3+1])+absd(B-previousRGB[t3+2]))/3;
          double still=1-smooth(.035,.12,change);
          age[i]=change<.055?min(3,(int)age[i]+1):0;
          if(age[i]>=2){
            double low=a<raw1[i]?a:raw1[i],high=a>raw1[i]?a:raw1[i];
            double other=high<raw2[i]?high:raw2[i],med=low>other?low:other;
            double weight=medianWeight*still;a=a*(1-weight)+med*weight;
          }
          double blend=retention*still;a=a*(1-blend)+previous[i]*blend;
        }else{age[i]=0;}
        raw2[i]=history?raw1[i]:candidate;raw1[i]=candidate;
      }else if(history&&temporal>0){
        double change=(absd(R-previousRGB[t3])+absd(G-previousRGB[t3+1])+absd(B-previousRGB[t3+2]))/3;
        double blend=temporal*(1-smooth(.025,.10,change))*(1-smooth(.08,.28,absd(a-previous[i])));
        a=a*(1-blend)+previous[i]*blend;
      }
      alpha[i]=previous[i]=a;previousRGB[t3]=R;previousRGB[t3+1]=G;previousRGB[t3+2]=B;
      rgba[j]=rgba[j+1]=rgba[j+2]=255;
      /* JS writes alpha to f32, then Math.round(alpha*255), not the double temporary. */
      rgba[j+3]=(unsigned char)((double)alpha[i]*255+.5);
    }
  }
}
