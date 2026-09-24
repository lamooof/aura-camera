/* Aura Camera 0.4.2. Configuration, RGB-guided matte reconstruction and depth fusion.
 * All buffers are per video session. No frame data is written to storage.
 */
(() => {
  'use strict';
  if (globalThis.AuraCore?.VERSION === '0.4.2') return;
  const VERSION = '0.4.2';
  const BACKGROUNDS = Object.freeze([
    {id:'studio',name:'Светлая студия'}, {id:'office',name:'Кабинет'},
    {id:'graphite',name:'Графит'}, {id:'mountains',name:'Горы'},
    {id:'dunes',name:'Дюны'}, {id:'ocean',name:'Океан'},
    {id:'forest',name:'Лес'}, {id:'aurora',name:'Сияние'}
  ]);
  const ALGORITHMS = Object.freeze({
    fast: {name:'Selfie · быстрый',matting:false},
    multiclass: {name:'SelfieMulticlass + RGB',matting:false},
    rvm: {name:'RVM · видеоматтинг',matting:true},
    modnet: {name:'MODNet · портретный маттинг',matting:true},
    depth: {name:'SelfieMulticlass + глубина',matting:false}
  });
  const PROFILES = Object.freeze({
    eco: {width:640,height:480,fps:15,guide:256,rvm:512,modnet:384},
    balanced: {width:960,height:720,fps:20,guide:320,rvm:640,modnet:512},
    high: {width:1280,height:720,fps:25,guide:384,rvm:768,modnet:640},
    ultra: {width:1280,height:720,fps:25,guide:512,rvm:960,modnet:768}
  });
  const DEFAULTS = Object.freeze({enabled:true,everywhere:true,meetEnabled:true,
    mode:'image',background:'studio',color:'#36435d',blur:18,threshold:0.5,
    quality:'balanced',algorithm:'multiclass',accelerator:'auto',processing:'efficient',edge:1,temporal:0.45,antiflicker:true,
    feather:2,depthStrength:0.45,depthInterval:400});
  const clamp = (v,lo,hi,fallback=lo) => typeof v==='number' && Number.isFinite(v) ? Math.max(lo,Math.min(hi,v)) : fallback;
  const unit = v => Number.isFinite(v) ? Math.max(0,Math.min(1,v)) : 0;
  const smooth = (lo,hi,v) => { const x=unit((v-lo)/(hi-lo));return x*x*(3-2*x); };
  function normalize(value) {
    const s=value && typeof value==='object'?value:{};
    return {
      enabled:typeof s.enabled==='boolean'?s.enabled:DEFAULTS.enabled,
      everywhere:typeof s.everywhere==='boolean'?s.everywhere:DEFAULTS.everywhere,
      meetEnabled:typeof s.meetEnabled==='boolean'?s.meetEnabled:DEFAULTS.meetEnabled,
      mode:['image','blur','color'].includes(s.mode)?s.mode:DEFAULTS.mode,
      background:BACKGROUNDS.some(b=>b.id===s.background)||s.background==='custom'?s.background:DEFAULTS.background,
      color:typeof s.color==='string' && /^#[0-9a-f]{6}$/i.test(s.color)?s.color:DEFAULTS.color,
      blur:Math.round(clamp(s.blur,6,32,DEFAULTS.blur)),
      threshold:clamp(s.threshold,0.3,0.75,DEFAULTS.threshold),
      quality:Object.hasOwn(PROFILES,s.quality)?s.quality:DEFAULTS.quality,
      algorithm:Object.hasOwn(ALGORITHMS,s.algorithm)?s.algorithm:DEFAULTS.algorithm,
      accelerator:['auto','cpu'].includes(s.accelerator)?s.accelerator:DEFAULTS.accelerator,
      processing:['efficient','detail'].includes(s.processing)?s.processing:DEFAULTS.processing,
      edge:Math.round(clamp(s.edge,1,8,DEFAULTS.edge)),
      temporal:clamp(s.temporal,0,0.6,DEFAULTS.temporal),
      antiflicker:typeof s.antiflicker==='boolean'?s.antiflicker:DEFAULTS.antiflicker,
      feather:clamp(s.feather,0,2,DEFAULTS.feather),
      depthStrength:clamp(s.depthStrength,0,1,DEFAULTS.depthStrength),
      depthInterval:Math.round(clamp(s.depthInterval,200,1500,DEFAULTS.depthInterval))
    };
  }
  function host(url) {try{return new URL(url).hostname.toLowerCase();}catch{return '';}}
  const isMeet = url => {const h=host(url);return h==='meet.google.com'||h.endsWith('.meet.google.com');};
  const isTelemost = url => {const h=host(url);return ['telemost.yandex.ru','telemost.yandex.com'].some(x=>h===x||h.endsWith('.'+x));};
  function siteAllowed(s,topURL='',frameURL='') {
    if(frameURL.startsWith('chrome-extension:')) return true;
    if(isMeet(topURL)||isMeet(frameURL)) return !!s.meetEnabled;
    return !!s.everywhere || isTelemost(topURL) || isTelemost(frameURL);
  }
  function fitSize(w,h,quality) {
    const p=PROFILES[quality]||PROFILES.high;
    w=Number.isFinite(w)&&w>0?w:640;h=Number.isFinite(h)&&h>0?h:480;
    const f=Math.min(1,p.width/w,p.height/h);
    return {width:Math.max(2,Math.floor(w*f/2)*2),height:Math.max(2,Math.floor(h*f/2)*2),fps:p.fps};
  }
  function fitLong(w,h,max,multiple=1) {
    const f=Math.min(1,max/Math.max(w,h));
    return {width:Math.max(multiple,Math.floor(w*f/multiple)*multiple),height:Math.max(multiple,Math.floor(h*f/multiple)*multiple)};
  }
  // Working alpha resolution is independent of outgoing RGB resolution.
  // Detail mode preserves the 0.4.0 full-resolution RGB reconstruction.
  function refinementSize(w,h,quality,processing) {
    if(processing==='detail')return {width:w,height:h};
    const cap={eco:320,balanced:480,high:640,ultra:768}[quality]||480;
    return fitLong(w,h,cap,2);
  }
  function guideSize(w,h,quality,processing) {
    const limit=(PROFILES[quality]||PROFILES.balanced).guide;
    return fitLong(w,h,processing==='detail'?limit:Math.min(256,limit,Math.max(w,h)/2),1);
  }
  function modelBudget(kind,quality,processing,backend='') {
    if(kind==='depth')return {limit:256,core:256};
    const p=PROFILES[quality]||PROFILES.balanced,cpu=backend==='ONNX WASM / CPU';
    if(processing==='detail')return {limit:p[kind],core:384};
    return {limit:Math.min(p[kind],kind==='rvm'?(cpu?512:640):(cpu?320:512)),core:cpu?256:320};
  }
  function speedPreset(s) {
    return normalize({...s,algorithm:'fast',quality:'balanced',processing:'efficient',accelerator:'auto'});
  }
  // New temporal guard is opt-in. Its preset never changes model, resolution or site policy.
  function antiflickerPreset(s) {return normalize({...s,antiflicker:true,temporal:0.4});}
  function temporalParams(options) {
    const dt=Number.isFinite(options.frameDeltaMs)?options.frameDeltaMs:1000/30;
    const strength=clamp(options.temporal,0,0.6,0);
    return {guard:options.antiflicker===true,reset:dt<=0||dt>200,
      retention:Math.pow(Math.min(.75,strength*1.25),Math.max(10,Math.min(200,dt))/(1000/30)),
      medianWeight:Math.min(1,strength/.4)};
  }
  function coverRect(iw,ih,w,h) {
    if(!(iw>0&&ih>0&&w>0&&h>0))throw new Error('Некорректный размер изображения');
    const f=Math.max(w/iw,h/ih);return {x:(w-iw*f)/2,y:(h-ih*f)/2,width:iw*f,height:ih*f};
  }
  function drawCover(ctx,image,w,h) {const r=coverRect(image.width||image.videoWidth,image.height||image.videoHeight,w,h);ctx.drawImage(image,r.x,r.y,r.width,r.height);}
  function slate(canvas,title='Подготовка фона…',subtitle='Aura Camera') {
    const c=canvas.getContext('2d');if(!c)return;
    c.save();c.setTransform(1,0,0,1,0,0);c.globalCompositeOperation='source-over';c.globalAlpha=1;c.filter='none';
    c.fillStyle='#15202c';c.fillRect(0,0,canvas.width,canvas.height);
    c.textAlign='center';c.textBaseline='middle';c.fillStyle='#e3eaf1';c.font=`500 ${Math.max(14,canvas.width/34)}px sans-serif`;
    c.fillText(title,canvas.width/2,canvas.height/2,canvas.width*.92);c.fillStyle='#91a7ba';c.font=`${Math.max(11,canvas.width/55)}px sans-serif`;
    c.fillText(subtitle,canvas.width/2,canvas.height/2+Math.max(28,canvas.width/24),canvas.width*.92);c.restore();
  }
  const validCustom = value => typeof value==='string'&&value.length<=4200000&&/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(value);

  // Pixel-centre bilinear resampling. Source and destination must be distinct.
  function sample(a,w,h,x,y) {
    x=Math.max(0,Math.min(w-1,x));y=Math.max(0,Math.min(h-1,y));
    const x0=Math.floor(x),y0=Math.floor(y),x1=Math.min(w-1,x0+1),y1=Math.min(h-1,y0+1),fx=x-x0,fy=y-y0;
    return (a[y0*w+x0]*(1-fx)+a[y0*w+x1]*fx)*(1-fy)+(a[y1*w+x0]*(1-fx)+a[y1*w+x1]*fx)*fy;
  }
  function resample(a,sw,sh,out,w,h) {
    if(sw*sh!==a.length||w*h!==out.length)throw new Error('Некорректный размер карты');
    if(sw===w&&sh===h){out.set(a);return out;}
    for(let y=0;y<h;y++)for(let x=0;x<w;x++)out[y*w+x]=sample(a,sw,sh,(x+.5)*sw/w-.5,(y+.5)*sh/h-.5);
    return out;
  }
  // Separable box mean, O(N), truncated boundary windows (constant fields remain constant).
  function boxMean(src,out,tmp,w,h,r) {
    for(let y=0;y<h;y++){
      const o=y*w;let sum=0;
      for(let k=0;k<=Math.min(r,w-1);k++)sum+=src[o+k];
      for(let x=0;x<w;x++){
        out[o+x]=sum/(Math.min(w-1,x+r)-Math.max(0,x-r)+1);
        if(x-r>=0)sum-=src[o+x-r];if(x+r+1<w)sum+=src[o+x+r+1];
      }
    }
    for(let x=0;x<w;x++){
      let sum=0;for(let k=0;k<=Math.min(r,h-1);k++)sum+=out[k*w+x];
      for(let y=0;y<h;y++){
        tmp[y*w+x]=sum/(Math.min(h-1,y+r)-Math.max(0,y-r)+1);
        if(y-r>=0)sum-=out[(y-r)*w+x];if(y+r+1<h)sum+=out[(y+r+1)*w+x];
      }
    }
    out.set(tmp);return out;
  }
  // Fast colour guided filter: solve a 3x3 RGB covariance at working resolution,
  // then reconstruct alpha with full-resolution RGB. This is not a blur of RGB.
  class RGBRefiner {
    constructor(){this.buffers=new Map();this.historyValid=false;this.lastSize='';this.guardMode=null;}
    buf(name,n){let a=this.buffers.get(name);if(!a||a.length!==n){a=new Float32Array(n);this.buffers.set(name,a);}return a;}
    reset(){this.historyValid=false;}
    close(){this.buffers.clear();this.historyValid=false;}
    refine(mask,fullRGB,w,h,guideRGB,gw,gh,options) {
      if(mask.data.length!==mask.width*mask.height||fullRGB.length!==w*h*4||guideRGB.length!==gw*gh*4)throw new Error('Несовпадение размеров RGB/маски');
      const n=gw*gh,N=w*h,r=Math.min(options.edge,gw-1,gh-1),eps=.0025;
      const tp=temporalParams(options);
      if(tp.guard!==this.guardMode||(tp.guard&&tp.reset))this.historyValid=false;
      this.guardMode=tp.guard;
      const raw1=tp.guard?this.buf('raw1',N):null,raw2=tp.guard?this.buf('raw2',N):null,age=tp.guard?this.buf('age',N):null;
      if(this.lastSize!==`${w},${h},${gw},${gh}`){this.historyValid=false;this.lastSize=`${w},${h},${gw},${gh}`;}
      const p=this.buf('p',n);resample(mask.data,mask.width,mask.height,p,gw,gh);
      for(let i=0;i<n;i++)p[i]=mask.matting?unit(p[i]):smooth(options.threshold-.18,options.threshold+.18,p[i]);
      const I=[this.buf('R',n),this.buf('G',n),this.buf('B',n)],means=[this.buf('mR',n),this.buf('mG',n),this.buf('mB',n)];
      const tmp=this.buf('tmp',n),product=this.buf('product',n),mp=this.buf('mp',n);
      for(let i=0;i<n;i++){I[0][i]=guideRGB[4*i]/255;I[1][i]=guideRGB[4*i+1]/255;I[2][i]=guideRGB[4*i+2]/255;}
      for(let c=0;c<3;c++)boxMean(I[c],means[c],tmp,gw,gh,r);
      boxMean(p,mp,tmp,gw,gh,r);
      const cov=[];
      for(const [a,b] of [[0,0],[0,1],[0,2],[1,1],[1,2],[2,2]]){
        const out=this.buf(`v${a}${b}`,n);for(let i=0;i<n;i++)product[i]=I[a][i]*I[b][i];
        boxMean(product,out,tmp,gw,gh,r);for(let i=0;i<n;i++)out[i]-=means[a][i]*means[b][i];cov.push(out);
      }
      const ip=[];
      for(let c=0;c<3;c++){
        const out=this.buf('ip'+c,n);for(let i=0;i<n;i++)product[i]=I[c][i]*p[i];
        boxMean(product,out,tmp,gw,gh,r);for(let i=0;i<n;i++)out[i]-=means[c][i]*mp[i];ip.push(out);
      }
      const coeff=[this.buf('aR',n),this.buf('aG',n),this.buf('aB',n),this.buf('b',n)];
      for(let i=0;i<n;i++){
        const A=cov[0][i]+eps,B=cov[1][i],C=cov[2][i],D=cov[3][i]+eps,E=cov[4][i],F=cov[5][i]+eps;
        const aa=D*F-E*E,ab=C*E-B*F,ac=B*E-C*D,dd=A*F-C*C,de=B*C-A*E,ff=A*D-B*B;
        const det=Math.max(1e-12,A*aa+B*ab+C*ac),u=ip[0][i],v=ip[1][i],z=ip[2][i];
        coeff[0][i]=(aa*u+ab*v+ac*z)/det;coeff[1][i]=(ab*u+dd*v+de*z)/det;coeff[2][i]=(ac*u+de*v+ff*z)/det;
        coeff[3][i]=mp[i]-coeff[0][i]*means[0][i]-coeff[1][i]*means[1][i]-coeff[2][i]*means[2][i];
      }
      const avg=coeff.map((a,c)=>boxMean(a,this.buf('avg'+c,n),tmp,gw,gh,r));
      const previous=this.buf('previous',N),previousRGB=this.buf('previousRGB',N*3),alpha=this.buf('alpha',N);
      const shift=mask.matting?(options.threshold-.5)*.35:0;
      // Calculate interpolation coordinates once; skip the covariance reconstruction
      // in certain foreground/background. This saves work without blurring RGB.
      const xs=this.buf('xs',w),xt=this.buf('xt',w),xf=this.buf('xf',w);
      for(let x=0;x<w;x++){const gx=Math.max(0,Math.min(gw-1,(x+.5)*gw/w-.5));xs[x]=Math.floor(gx);xt[x]=Math.min(gw-1,xs[x]+1);xf[x]=gx-xs[x];}
      const ar=avg[0],ag=avg[1],ab=avg[2],bb=avg[3];
      for(let y=0;y<h;y++){
        const gy=Math.max(0,Math.min(gh-1,(y+.5)*gh/h-.5)),y0=Math.floor(gy),y1=Math.min(gh-1,y0+1),fy=gy-y0,o0=y0*gw,o1=y1*gw;
        for(let x=0;x<w;x++){
          const i=y*w+x,j=i*4,k=i*3,u=o0+xs[x],v=o0+xt[x],z=o1+xs[x],t=o1+xt[x],fx=xf[x];
          const w0=(1-fx)*(1-fy),w1=fx*(1-fy),w2=(1-fx)*fy,w3=fx*fy;
          const base=p[u]*w0+p[v]*w1+p[z]*w2+p[t]*w3;
          const R=fullRGB[j]/255,G=fullRGB[j+1]/255,B=fullRGB[j+2]/255;
          let a;
          if(base>.9999)a=1;
          else if(base<.0001)a=0;
          else{
            const q=(ar[u]*w0+ar[v]*w1+ar[z]*w2+ar[t]*w3)*R
              +(ag[u]*w0+ag[v]*w1+ag[z]*w2+ag[t]*w3)*G
              +(ab[u]*w0+ab[v]*w1+ab[z]*w2+ab[t]*w3)*B
              +(bb[u]*w0+bb[v]*w1+bb[z]*w2+bb[t]*w3);
            a=unit(.9*q+.1*base-shift);
            if(base>.998&&a>.975)a=1;if(base<.002&&a<.025)a=0;
          }
          if(tp.guard){
            const candidate=a;
            if(this.historyValid&&options.temporal>0){
              const change=(Math.abs(R-previousRGB[k])+Math.abs(G-previousRGB[k+1])+Math.abs(B-previousRGB[k+2]))/3;
              // RGB motion, not an alpha jump, invalidates history. A mask glitch is
              // exactly the condition we want to filter when the source is stationary.
              const still=1-smooth(.035,.12,change);
              age[i]=change<.055?Math.min(3,age[i]+1):0;
              if(age[i]>=2){
                const med=Math.max(Math.min(a,raw1[i]),Math.min(Math.max(a,raw1[i]),raw2[i]));
                const weight=tp.medianWeight*still;a=a*(1-weight)+med*weight;
              }
              const blend=tp.retention*still;a=a*(1-blend)+previous[i]*blend;
            }else{age[i]=0;}
            raw2[i]=this.historyValid?raw1[i]:candidate;raw1[i]=candidate;
          }else if(this.historyValid&&options.temporal>0){
            const change=(Math.abs(R-previousRGB[k])+Math.abs(G-previousRGB[k+1])+Math.abs(B-previousRGB[k+2]))/3;
            const blend=options.temporal*(1-smooth(.025,.10,change))*(1-smooth(.08,.28,Math.abs(a-previous[i])));
            a=a*(1-blend)+previous[i]*blend;
          }
          alpha[i]=previous[i]=a;previousRGB[k]=R;previousRGB[k+1]=G;previousRGB[k+2]=B;
        }
      }
      this.historyValid=true;return alpha;
    }
  }
  const quantile=(values,q)=>{if(!values.length)return NaN;values.sort((a,b)=>a-b);return values[Math.floor((values.length-1)*q)];};
  // MiDaS predicts RELATIVE INVERSE depth: larger means closer, not metres.
  // Only uncertain segmentation pixels may be suppressed; confident person is protected.
  function depthFuse(mask,depth,currentRGB,referenceRGB,w,h,strength,age=0) {
    const result={applied:false,reason:'Нет надёжного разделения по глубине',suppressed:0};
    if(!depth||!depth.data||age>900||strength<=0)return result;
    const fg=[],bg=[],all=[];
    const W=mask.width,H=mask.height;
    for(let y=0;y<H;y+=3)for(let x=0;x<W;x+=3){
      const d=sample(depth.data,depth.width,depth.height,(x+.5)*depth.width/W-.5,(y+.5)*depth.height/H-.5),a=mask.data[y*W+x];
      if(!Number.isFinite(d))continue;all.push(d);
      if(a>.92&&x>W*.15&&x<W*.85&&y>H*.1&&y<H*.9)fg.push(d);else if(a<.08)bg.push(d);
    }
    if(fg.length<20||bg.length<20)return result;
    const f=quantile(fg,.5),b=quantile(bg,.5),lo=quantile(all,.05),hi=quantile(all,.95),range=hi-lo;
    if(!(range>1e-6)||!(f-b>range*.12))return result;
    result.applied=true;result.reason='Относительная глубина применяется к спорным участкам';
    for(let y=0;y<H;y++)for(let x=0;x<W;x++){
      const i=y*W+x,a=mask.data[i];if(a<=.02||a>=.92)continue;
      const d=sample(depth.data,depth.width,depth.height,(x+.5)*depth.width/W-.5,(y+.5)*depth.height/H-.5);
      const far=1-smooth(b+(f-b)*.15,f-(f-b)*.15,d);
      const xx=Math.min(w-1,Math.floor(x*w/W)),yy=Math.min(h-1,Math.floor(y*h/H)),j=(yy*w+xx)*4;
      const change=referenceRGB&&currentRGB?(Math.abs(referenceRGB[j]-currentRGB[j])+Math.abs(referenceRGB[j+1]-currentRGB[j+1])+Math.abs(referenceRGB[j+2]-currentRGB[j+2]))/(3*255):0;
      const weight=strength*far*(1-smooth(.025,.10,change))*(1-smooth(450,900,age))*(1-smooth(.70,.92,a));
      mask.data[i]=unit(a*(1-weight));if(weight>.1)result.suppressed++;
    }
    return result;
  }
  globalThis.AuraCore=Object.freeze({VERSION,BACKGROUNDS,ALGORITHMS,PROFILES,DEFAULTS,normalize,fitSize,fitLong,refinementSize,guideSize,modelBudget,speedPreset,antiflickerPreset,temporalParams,host,isMeet,isTelemost,siteAllowed,coverRect,drawCover,slate,validCustom,unit,smooth,sample,resample,boxMean,RGBRefiner,depthFuse});
})();
