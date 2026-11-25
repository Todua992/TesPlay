import { useEffect, useRef, useState } from "react";
import { Camera, Check, CirclePlay, Grid2X2, LoaderCircle, Play, SlidersHorizontal, Smartphone, Unplug } from "lucide-react";
import { api, ApiError, errorMessage } from "./api";
import { Brand } from "./components";
import { beginPlaybackGesture } from "./playback-audio";
import QrCode from "./QrCode";
import type { Auth } from "./types";
import "./rear-screen.css";

type Challenge = { id?: string; code: string; token?: string; verificationUrl?: string; expiresAt: number | string };
type Props = {
  auth: Auth | null;
  roomId: string;
  paired: boolean;
  onPairState: (paired: boolean) => void;
  onAuth: (auth: Auth) => void;
  onDisconnect: () => Promise<void>;
  serverError?: string;
};

export default function RearScreen({auth,roomId,paired,onPairState,onAuth,onDisconnect,serverError}:Props) {
  const signedIn=!!auth?.user && auth.scope!=="remote";
  const [challenge,setChallenge]=useState<Challenge|null>(null);
  const [error,setError]=useState("");
  const [generation,setGeneration]=useState(0);
  const [disconnecting,setDisconnecting]=useState(false);
  const [publicUrl,setPublicUrl]=useState(location.origin);
  const [scale,setScale]=useState(()=>Math.min(innerWidth/1280,innerHeight/800));
  const pending=useRef<{key:string;promise:Promise<Challenge>}|null>(null);
  useEffect(()=>{
    const resize=()=>setScale(Math.min(innerWidth/1280,innerHeight/800));
    window.addEventListener("resize",resize);
    window.visualViewport?.addEventListener("resize",resize);
    return()=>{window.removeEventListener("resize",resize);window.visualViewport?.removeEventListener("resize",resize);};
  },[]);
  useEffect(()=>{
    if(!signedIn)return;
    const controller=new AbortController();
    void api<{publicUrl?:string}>("/settings",undefined,undefined,controller.signal).then(value=>{
      if(!controller.signal.aborted && value.publicUrl)setPublicUrl(value.publicUrl.replace(/\/$/,""));
    }).catch(()=>{});
    return()=>controller.abort();
  },[signedIn]);
  useEffect(()=>{
    if(!roomId || !signedIn)return;
    const controller=new AbortController();
    let timer:ReturnType<typeof setTimeout>;
    const sync=async()=>{
      try{
        const state=await api<{paired:boolean}>(`/remote/state?roomId=${encodeURIComponent(roomId)}`,undefined,undefined,controller.signal);
        if(!controller.signal.aborted){onPairState(state.paired);setError("");}
      }catch(reason){
        if(!controller.signal.aborted){
          setError(errorMessage(reason));
          if(reason instanceof ApiError && reason.status===401)void api<Auth>("/auth/status").then(onAuth).catch(()=>{});
        }
      }
      if(!controller.signal.aborted)timer=setTimeout(sync,2500);
    };
    void sync();
    return()=>{controller.abort();clearTimeout(timer);};
  },[roomId,signedIn,onPairState,onAuth]);
  useEffect(()=>{
    setChallenge(null);
    if(paired){pending.current=null;return;}
    if(!auth || (signedIn && !roomId))return;
    let dead=false;
    setError("");
    const key=`${signedIn?roomId:"signin"}:${generation}`;
    // Reuse the request during React's effect replay so binding cookies cannot race.
    if(pending.current?.key!==key)pending.current={key,promise:signedIn
      ? api<Challenge>("/remote/pair",{})
      : api<Challenge>("/auth/qr/init",{remoteScreen:true})};
    let timer:ReturnType<typeof setTimeout>;
    const poll=async(value:Challenge)=>{
      if(dead)return;
      const expiresAt=typeof value.expiresAt==="number"?value.expiresAt:Date.parse(value.expiresAt);
      if(Date.now()>=expiresAt){setGeneration(n=>n+1);return;}
      try{
        if(!signedIn && value.id){
          const result=await api<{status:string;auth?:Auth}>("/auth/qr/poll",{id:value.id});
          if(dead)return;
          setError("");
          if(result.status==="approved" && result.auth){onAuth(result.auth);return;}
        }
        timer=setTimeout(()=>void poll(value),2500);
      }catch(reason){
        if(dead)return;
        if(reason instanceof ApiError && reason.status===410){setGeneration(n=>n+1);return;}
        setError(errorMessage(reason));timer=setTimeout(()=>void poll(value),5000);
      }
    };
    pending.current.promise.then(value=>{if(!dead){setChallenge(value);timer=setTimeout(()=>void poll(value),2500);}}).catch(reason=>{
      if(!dead){pending.current=null;setError(errorMessage(reason));timer=setTimeout(()=>setGeneration(n=>n+1),30_000);}
    });
    return()=>{dead=true;clearTimeout(timer);};
  },[auth!==null,signedIn,roomId,paired,generation,onAuth]);
  const link=challenge?.verificationUrl || (challenge?.token?`${publicUrl}/?remote=${encodeURIComponent(challenge.code)}#token=${encodeURIComponent(challenge.token)}`:"");
  const steps=paired
    ? [{Icon:Grid2X2,title:"Choose on your phone",body:"Open Browse and pick a title"},{Icon:CirclePlay,title:"Press play",body:"Your video fills this screen"},{Icon:SlidersHorizontal,title:"Keep your phone handy",body:"Pause, seek and adjust the sound"}]
    : [{Icon:Camera,title:"Scan the QR code",body:"Open your phone’s camera"},{Icon:Grid2X2,title:signedIn?"Choose something":"Approve this screen",body:signedIn?"Browse TesPlay on your phone":"Sign in on your phone and match the code"},{Icon:CirclePlay,title:"Press play",body:"Choose a title on your phone, watch it here"}];
  return <div className="rear-screen" onPointerDown={beginPlaybackGesture}>
    <div className="rear-stage" style={{transform:`scale(${scale})`}}>
      <header className="rear-header"><Brand/><div className={`rear-status ${paired?"connected":""}`} role="status" aria-live="polite"><i/>{paired?"Phone connected":"Waiting for your phone"}</div></header>
      <main className="rear-layout">
        <section className="rear-instructions"><p className="rear-kicker">{paired?"Phone connected":"Rear screen"}</p><h1>{paired?<>Choose a title<br/>on your phone</>:<>Watch here, control<br/>it from your phone</>}</h1><p className="rear-intro">{paired?"It plays on this screen when you press play":"Scan the code to use your phone as the remote"}</p>
          <ol className="rear-steps">{steps.map(({Icon,title,body})=><li className="rear-step" key={title}><span className="rear-step-icon"><Icon size={20}/></span><div><h2>{title}</h2><p>{body}</p></div></li>)}</ol>
        </section>
        <aside className={`rear-pair-card ${paired?"connected":""}`}>
          {paired?<><div className="rear-phone-scene" aria-hidden="true"><div className="rear-phone"><Play size={29} fill="currentColor"/></div><span className="rear-phone-check"><Check size={20}/></span></div><h2>Connected</h2><p className="rear-pair-caption"><strong>Your phone is the remote</strong><br/>Choose a title and it plays here</p><button className="rear-disconnect" disabled={disconnecting} onClick={async()=>{setDisconnecting(true);setError("");try{await onDisconnect();}catch(reason){setError(errorMessage(reason));}finally{setDisconnecting(false);}}}>{disconnecting?<LoaderCircle size={18} className="spin"/>:<Unplug size={18}/>}Disconnect remote</button></>
            : <><h2>Scan to connect</h2>{link?<QrCode value={link} label="Scan to connect your phone to the Tesla rear screen"/>:<div className="rear-qr-loading" role="status"><LoaderCircle size={32} className="spin"/><span>Preparing your QR code…</span></div>}<p className="rear-pair-caption"><strong>Your phone becomes the remote</strong><br/>{signedIn?"Scan with your phone’s camera":challenge?<>Match code <span className="rear-code">{challenge.code}</span> on your phone</>:"Sign in and approve on your phone"}</p></>}
        </aside>
      </main>
      <footer className="rear-footer"><span><Smartphone size={17}/>Controlled from your phone</span><i/></footer>
      {(error||serverError)&&<p className="rear-error" role="alert">{error||serverError}</p>}
    </div>
  </div>;
}
