import { useState, useEffect, useRef } from 'react';
import {
  Search, Briefcase, CheckSquare, Settings, HelpCircle, RotateCcw,
  X, ChevronDown, ChevronUp, Upload, FileText, Mail, Trash2,
  Plus, ExternalLink, AlertTriangle, CheckCircle, Copy,
  Sparkles, Building2, MapPin, DollarSign, Star, Flag,
  ArrowRight, Clock, Filter, SortDesc, PlusCircle, User,
  Link, ChevronRight, ChevronLeft, Wand2, Copyright,
} from 'lucide-react';
import {
  getSavedJobs, setSavedJobs, clearSavedJobs,
  getAppliedJobs, markDocGenerated, addStatusToJob,
  deleteAppliedJob, clearAppliedJobs, isJobApplied,
  getSavedInstructions, saveInstructions,
  getLocalApiKey, setLocalApiKey,
  getApiKey, setApiKey,
  getLocalSerperKey, setLocalSerperKey,
  setLastSearchQuery,
  setUploadedResume, getUploadedResume, getUploadedResumeMeta,
  setUploadedCover, getUploadedCover, getUploadedCoverMeta,
  setUploadedResumeFileData, getUploadedResumeFileData,
  setUploadedCoverFileData, getUploadedCoverFileData,
  clearAllStorage, getSavedProfile, saveProfile,
  getSearchHistory, saveSearchToHistory, deleteSearchFromHistory, deleteOldestSearch,
  isHistoryFull, getHistoryCount, SearchSnapshot, ExcludedJobSnapshot,
  exportAppData, validateImport, importAppData,
  getWizardSeen, setWizardSeen,
  SavedJob, AppliedJob, StatusEntry, UploadMeta,
  getAIProvider, setAIProvider, AIProvider,
  computeExtractionSignature, getStoredExtractionSignature,
  setStoredExtractionSignature, clearStoredExtractionSignature,
  isExtractionStale,
} from '../lib/storage';
import {
  DEFAULT_PROFILE, buildJobSearchInstructions,
  buildResumeInstructions, buildCoverLetterInstructions,
  DEFAULT_JOB_SEARCH_INSTRUCTIONS, DEFAULT_RESUME_INSTRUCTIONS,
  DEFAULT_COVER_LETTER_INSTRUCTIONS, CandidateProfile,
} from '../lib/instructions';
import {
  validateAPIKey, getAPIKeyPlaceholder, getAPIKeyNote,
  getProviderName, getProviderSetupURL, getProviderSetupSteps,
} from '../lib/ai-providers';
import { validateAllLocations, validateLocationInput } from '../lib/location-validator';

type Tab = 'search' | 'board' | 'applied' | 'settings';
type GenerateType = 'resume' | 'coverLetter';

interface ExcludedJob {
  id: string; company: string; title: string;
  layerFailed: string; reason: string; excluded: true;
  category?: string; isRemote?: boolean; isHybrid?: boolean;
  industry?: string[]; salaryMin?: number; salaryMax?: number;
  salaryDisplay?: string; salaryNote?: string; rating?: number;
  auditLabel?: string; roleSummary?: string; whyYouFit?: string[];
  requirements?: string[]; companyInfo?: string; goldFlags?: string[];
  redFlags?: string[]; applyUrl?: string; careersUrl?: string;
  aboutUrl?: string; jobDescUrl?: string; postedDate?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

// Safe JSON parse for fetch responses — prevents "Unexpected token '<'" when
// the server returns an HTML error page instead of JSON (e.g. 404 on missing route)
async function safeJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    // Server returned HTML (error page) — surface a useful message
    const status = res.status;
    if (status === 404) return { error: `API route not found (${res.url.split('/api/')[1] ?? res.url})` };
    return { error: `Server error (${status}): unexpected response format` };
  }
}

function readyTime(mins: number): string {
  const d = new Date(Date.now() + mins * 60000);
  let h = d.getHours(), m = d.getMinutes();
  const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return `${h}:${String(m).padStart(2,'0')} ${ap}`;
}
function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})
    +' at '+d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
}
function statusColor(s: StatusEntry['status']) {
  return s==='applied'?'#007AFF':s==='interview'?'#FF9500':s==='offer'?'#1A7A3C':'#007AFF';
}
function statusBg(s: StatusEntry['status']) {
  return s==='applied'?'rgba(0,122,255,0.1)':s==='interview'?'rgba(255,204,0,0.12)':s==='offer'?'rgba(52,199,89,0.12)':'rgba(0,122,255,0.12)';
}
function fmtSalary(n: number): string {
  if (n === 0) return 'Volunteer';
  return `$${(n/1000).toFixed(0)}K`;
}
// Parse via base64 fallback (for when FormData fails on mobile)
async function parseFileBase64(file: File): Promise<string> {
  const ext = file.name.split('.').pop()?.toLowerCase();
  
  if (ext === 'html' || ext === 'htm') {
    const html = await file.text();
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // For binary files, encode to base64 and send to API
  // Use browser-native btoa (chunked to handle large files) instead of Buffer (Node-only)
  const arrayBuffer = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...Array.from(bytes.subarray(i, i + chunkSize)));
  }
  const base64 = btoa(binary);
  
  console.log('Sending via base64 fallback, size:', base64.length);
  
  // Try full parsing first
  let response = await fetch('/ape/api/parse-resume-base64', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename: file.name,
      data: base64,
    }),
  });

  // If that fails, try simple parsing (no external libs)
  if (!response.ok) {
    console.log('Base64 parsing failed, trying simple parsing...');
    response = await fetch('/ape/api/parse-simple', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: file.name,
        data: base64,
      }),
    });
  }

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData?.error || `Server error (${response.status})`);
  }

  const result = await response.json();
  if (!result.text) {
    throw new Error(result.error || 'No text extracted');
  }

  return result.text;
}

// Browser detection utility
function getBrowserInfo() {
  const ua = navigator.userAgent;
  const isSafari = /Safari/.test(ua) && !/Chrome|Chromium|OPR|Brave|Edge/.test(ua);
  const isFirefox = /Firefox/.test(ua);
  const isChrome = /Chrome|Chromium/.test(ua) && !/Brave|Edge|OPR/.test(ua);
  const isBrave = /Brave/.test(ua);
  const isEdge = /Edg/.test(ua);
  const isOpera = /OPR/.test(ua);
  const isIOS = /iPad|iPhone|iPod/.test(ua);
  const isAndroid = /Android/.test(ua);
  const isDesktop = !isIOS && !isAndroid;
  
  const browserType = isBrave ? 'Brave' : isEdge ? 'Edge' : isOpera ? 'Opera' : isFirefox ? 'Firefox' : isChrome ? 'Chrome' : isSafari ? 'Safari' : 'Unknown';
  const platform = isIOS ? 'iOS' : isAndroid ? 'Android' : 'Desktop';
  const isPrivacyBrowser = isBrave; // Add more privacy browsers as needed
  
  return {
    browserType,
    platform,
    isPrivacyBrowser,
    isIOS,
    isAndroid,
    isDesktop,
    userAgent: ua,
    displayName: `${platform} ${browserType}`,
  };
}

// Test if browser can upload files
function testUploadCapability(): { canUpload: boolean; reason?: string } {
  try {
    const test = new FormData();
    test.append('test', new Blob(['test']), 'test.txt');
    return { canUpload: true };
  } catch (err) {
    return { 
      canUpload: false, 
      reason: `FormData not supported: ${err instanceof Error ? err.message : 'Unknown'}` 
    };
  }
}

async function parseFile(file: File): Promise<string> {
  const browser = getBrowserInfo();
  const uploadTest = testUploadCapability();
  
  // Debug logging
  console.log('=== parseFile Debug ===');
  console.log('Browser:', browser.displayName);
  console.log('User Agent:', browser.userAgent);
  console.log('Is Privacy Browser:', browser.isPrivacyBrowser);
  console.log('Upload Capable:', uploadTest.canUpload);
  console.log('File name:', file.name);
  console.log('File type:', file.type);
  console.log('File size:', file.size);
  
  // For HTML, we can still parse client-side (it's safe and small)
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (ext==='html'||ext==='htm') {
    try {
      const html = await file.text();
      // Strip HTML tags safely
      return html
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    } catch (err) {
      throw new Error(`HTML parsing failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  // For PDF and DOCX, use backend API (works on all devices)
  if (ext === 'docx' || ext === 'pdf') {
    // Warn user if using privacy browser
    if (browser.isPrivacyBrowser) {
      console.warn(`⚠️ You're using ${browser.browserType} which may block file uploads due to privacy shields.`);
      console.warn('If upload fails, try disabling shields for this site or using a standard browser.');
    }
    
    if (!uploadTest.canUpload) {
      throw new Error(`Upload not supported on this browser: ${uploadTest.reason}`);
    }

    try {
      console.log('Creating FormData...');
      const formData = new FormData();
      // Explicitly pass filename as third arg — iOS Safari can strip or rename it otherwise
      formData.append('file', file, file.name || 'document.pdf');
      
      console.log('FormData created, file appended');
      console.log('Sending to /api/parse-resume...');

      const response = await fetch('/ape/api/parse-resume', {
        method: 'POST',
        body: formData,
      });

      console.log('Response status:', response.status);
      console.log('Response ok:', response.ok);

      if (!response.ok) {
        let errData: any = {};
        try {
          errData = await response.json();
        } catch (parseErr) {
          console.error('Failed to parse error response:', parseErr);
        }
        console.error('API error response:', errData);
        
        throw new Error(errData?.error || `Server error (${response.status})`);
      }

      const data = await response.json();
      console.log('API response received, text length:', data.text?.length || 0);
      
      if (!data.text) {
        throw new Error(data.error || 'No text extracted from file');
      }

      console.log('✓ parseFile successful on', browser.displayName);
      return data.text;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error('✗ parseFile FormData failed:', errMsg);
      console.error('Browser:', browser.displayName);
      console.error('File:', file.name);
      console.log('Attempting base64 fallback after FormData failure...');
      
      // Always fall back to base64 on any failure (covers mobile network errors,
      // non-400 status codes, and privacy browser blocks)
      try {
        return await parseFileBase64(file);
      } catch (fallbackErr) {
        const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        console.error('✗ Base64 fallback also failed:', fallbackMsg);
        throw new Error(fallbackMsg);
      }
    }
  }

  throw new Error('Unsupported file type. Use HTML, DOCX, or PDF.');
}

async function fileToDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read file as data URI'));
    reader.readAsDataURL(file);
  });
}

// ── Loading Overlay ────────────────────────────────────────────────────────
function LoadingOverlay({onCancel,onDismiss,minutesEta=6,dismissOnly=false,customMessage,phaseMessage}:{
  onCancel?:()=>void;onDismiss?:()=>void;minutesEta?:number;dismissOnly?:boolean;customMessage?:string;phaseMessage?:string;
}) {
  const [confirm,setConfirm]=useState(false);
  const eta=readyTime(minutesEta);
  useEffect(()=>{
    if(dismissOnly) return;
    function onKey(e:KeyboardEvent){if(e.key==='Escape')setConfirm(true);}
    window.addEventListener('keydown',onKey);
    return()=>window.removeEventListener('keydown',onKey);
  },[dismissOnly]);
  const mainMsg=customMessage||phaseMessage||(dismissOnly?'Generation in Progress...':'Results in Progress.');
  return (
    <div style={{position:'fixed',inset:0,background:'#000000',zIndex:1000,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:32}}>
      {confirm&&!dismissOnly?(
        <div style={{background:'rgba(28,28,30,0.98)',borderRadius:20,padding:'32px 28px',textAlign:'center',maxWidth:340,border:'0.5px solid rgba(255,255,255,0.12)',boxShadow:'0 20px 60px rgba(0,0,0,0.8)'}}>
          <div style={{width:52,height:52,borderRadius:'50%',background:'rgba(255,59,48,0.15)',display:'flex',alignItems:'center',justifyContent:'center',margin:'0 auto 16px'}}>
            <AlertTriangle size={24} color="#FF3B30"/>
          </div>
          <h2 style={{color:'#fff',fontSize:20,fontWeight:700,letterSpacing:'-0.02em',marginBottom:8}}>Cancel Search?</h2>
          <p style={{color:'rgba(255,255,255,0.5)',fontSize:13,marginBottom:24,lineHeight:1.6}}>All search progress will be lost.</p>
          <div style={{display:'flex',gap:10,justifyContent:'center'}}>
            <button onClick={onCancel} style={{background:'#FF3B30',color:'#fff',border:'none',borderRadius:50,padding:'10px 20px',fontWeight:600,cursor:'pointer',fontSize:13}}>Yes, cancel</button>
            <button onClick={()=>setConfirm(false)} style={{background:'rgba(255,255,255,0.1)',color:'#fff',border:'0.5px solid rgba(255,255,255,0.18)',borderRadius:50,padding:'10px 20px',fontWeight:600,cursor:'pointer',fontSize:13}}>Keep going</button>
          </div>
        </div>
      ):(
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <div style={{width:172,height:172,borderRadius:24,overflow:'hidden',flexShrink:0,boxShadow:'0 8px 32px rgba(0,0,0,0.8)'}}><img src="https://cdn.dribbble.com/userupload/19917114/file/original-880f3ab68d9bcfe041db6649d5f8003b.gif" alt="Loading" style={{width:'100%',height:'100%',objectFit:'cover',display:'block'}}/></div>
          <div style={{textAlign:'center'}}>
            <div style={{fontSize:20,fontWeight:700,letterSpacing:'-0.02em',color:'rgba(255,255,255,0.95)',marginBottom:6}}>{mainMsg}</div>
            {!dismissOnly&&(
              <div style={{fontSize:13,color:'rgba(255,255,255,0.45)',marginTop:4}}>
                Expected results by {eta} — but hopefully sooner.
              </div>
            )}
          </div>
          {dismissOnly
            ?<button onClick={onDismiss} style={{background:'none',border:'none',cursor:'pointer',color:'rgba(255,255,255,0.4)',fontSize:13,padding:'8px 16px'}}>Dismiss</button>
            :<button onClick={()=>setConfirm(true)} style={{background:'none',border:'none',cursor:'pointer',color:'rgba(255,255,255,0.28)',fontSize:12,padding:'8px 16px'}}>Esc to cancel</button>
          }
        </>
      )}
    </div>
  );
}

// ── Welcome Modal ──────────────────────────────────────────────────────────
function WelcomeModal({onBegin,onSkip}:{onBegin:()=>void;onSkip:()=>void;}) {
  return (
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.45)',backdropFilter:'blur(12px)',WebkitBackdropFilter:'blur(12px)',zIndex:2000,display:'flex',alignItems:'center',justifyContent:'center',padding:20}}>
      <div style={{background:'rgba(255,255,255,0.96)',borderRadius:24,width:'100%',maxWidth:480,boxShadow:'0 24px 80px rgba(0,0,0,0.25)',overflow:'hidden',border:'0.5px solid rgba(255,255,255,0.8)'}}>
        <div style={{padding:'36px 32px 28px',textAlign:'center'}}>
          <div style={{display:'inline-flex',alignItems:'center',justifyContent:'center',width:64,height:64,borderRadius:18,background:'linear-gradient(135deg,#007AFF,#5856D6)',marginBottom:20,boxShadow:'0 4px 16px rgba(0,122,255,0.35)'}}>
            <Sparkles size={28} color="#fff"/>
          </div>
          <h1 style={{fontSize:26,fontWeight:700,letterSpacing:'-0.03em',marginBottom:12,lineHeight:1.2,color:'#000'}}>Welcome to <span style={{color:'#007AFF'}}>Ape X Job Hunt</span></h1>
          <p style={{fontSize:14,color:'rgba(60,60,67,0.65)',lineHeight:1.7,marginBottom:28}}>
            Your intelligent job search assistant. Let&apos;s set up your profile to find the best opportunities for you.
          </p>
          <div style={{display:'flex',flexDirection:'column',gap:10,alignItems:'center'}}>
            <button onClick={onBegin} style={{width:'100%',maxWidth:280,padding:'14px 24px',background:'#007AFF',color:'#fff',border:'none',borderRadius:50,cursor:'pointer',fontWeight:600,fontSize:15,letterSpacing:'-0.01em'}}>
              Get Started
            </button>
            <button onClick={onSkip} style={{background:'none',border:'none',cursor:'pointer',fontSize:13,color:'rgba(60,60,67,0.5)',padding:'4px 0'}}>
              Skip for now
            </button>
          </div>
          <div style={{marginTop:24}}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/ape/ape-x-full-logo.png" alt="Ape X" style={{width:'100%',maxWidth:320,height:'auto',maxHeight:220,objectFit:'contain',display:'block',margin:'0 auto',opacity:0.85}}/>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Confirm Modal (generic) ────────────────────────────────────────────────
function ConfirmModal({title,body,confirmLabel='Confirm',danger=true,onConfirm,onClose}:{
  title:string;body:string;confirmLabel?:string;danger?:boolean;onConfirm:()=>void;onClose:()=>void;
}) {
  return (
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.4)',backdropFilter:'blur(12px)',WebkitBackdropFilter:'blur(12px)',zIndex:800,display:'flex',alignItems:'center',justifyContent:'center',padding:20}}>
      <div style={{background:'rgba(255,255,255,0.96)',borderRadius:20,width:'100%',maxWidth:380,boxShadow:'0 20px 60px rgba(0,0,0,0.2)',padding:28,textAlign:'center',border:'0.5px solid rgba(255,255,255,0.8)'}}>
        <div style={{width:52,height:52,borderRadius:'50%',background:danger?'rgba(255,59,48,0.12)':'rgba(0,122,255,0.1)',display:'flex',alignItems:'center',justifyContent:'center',margin:'0 auto 16px'}}>
          <AlertTriangle size={24} color={danger?'#FF3B30':'#007AFF'}/>
        </div>
        <h2 style={{fontSize:20,fontWeight:700,letterSpacing:'-0.02em',marginBottom:8,color:'#000'}}>{title}</h2>
        <p style={{fontSize:13,color:'rgba(60,60,67,0.6)',lineHeight:1.7,marginBottom:24}}>{body}</p>
        <div style={{display:'flex',gap:10,justifyContent:'center'}}>
          <button onClick={onConfirm} style={{display:'flex',alignItems:'center',gap:6,padding:'10px 20px',background:danger?'#FF3B30':'#007AFF',color:'#fff',border:'none',borderRadius:50,cursor:'pointer',fontWeight:600,fontSize:13}}>
            {confirmLabel}
          </button>
          <button onClick={onClose} style={{padding:'10px 20px',background:'rgba(120,120,128,0.12)',color:'#000',border:'none',borderRadius:50,cursor:'pointer',fontWeight:600,fontSize:13}}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ── Success Modal ──────────────────────────────────────────────────────────
function SuccessModal({onSearch,onClose}:{onSearch:()=>void;onClose:()=>void;}) {
  return (
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.4)',backdropFilter:'blur(12px)',WebkitBackdropFilter:'blur(12px)',zIndex:800,display:'flex',alignItems:'center',justifyContent:'center',padding:20}}>
      <div style={{background:'rgba(255,255,255,0.96)',borderRadius:20,width:'100%',maxWidth:400,boxShadow:'0 20px 60px rgba(0,0,0,0.2)',padding:32,textAlign:'center',border:'0.5px solid rgba(255,255,255,0.8)'}}>
        <div style={{width:64,height:64,borderRadius:'50%',background:'rgba(52,199,89,0.12)',display:'flex',alignItems:'center',justifyContent:'center',margin:'0 auto 16px'}}>
          <CheckCircle size={32} color="#34C759"/>
        </div>
        <h2 style={{fontSize:22,fontWeight:700,letterSpacing:'-0.02em',marginBottom:8,color:'#000'}}>Setup Complete</h2>
        <p style={{fontSize:14,color:'rgba(60,60,67,0.6)',lineHeight:1.6,marginBottom:24}}>Your profile is saved. Ready to find your next role.</p>
        <div style={{display:'flex',gap:10,justifyContent:'center'}}>
          <button onClick={onSearch} style={{display:'flex',alignItems:'center',gap:6,padding:'12px 24px',background:'#007AFF',color:'#fff',border:'none',borderRadius:50,cursor:'pointer',fontWeight:600,fontSize:14}}>
            <Search size={15}/> Search Now
          </button>
          <button onClick={onClose} style={{padding:'12px 20px',background:'rgba(120,120,128,0.12)',color:'#000',border:'none',borderRadius:50,cursor:'pointer',fontWeight:600,fontSize:14}}>Later</button>
        </div>
      </div>
    </div>
  );
}

// ── Salary Slider ──────────────────────────────────────────────────────────
function SalarySlider({min,max,onChange}:{min:number;max:number;onChange:(min:number,max:number)=>void;}) {
  const STEP=10000, MIN_VAL=0, MAX_VAL=500000;
  return (
    <div style={{padding:'8px 0'}}>
      <div style={{display:'flex',justifyContent:'space-between',marginBottom:12}}>
        <div style={{textAlign:'center'}}>
          <div style={{fontSize:10,fontWeight:700,letterSpacing:'0.1em',textTransform:'uppercase',color:'rgba(60,60,67,0.6)',marginBottom:4}}>Minimum</div>
          <div style={{fontSize:18,fontWeight:700,color:'#000000',}}>{fmtSalary(min)}</div>
        </div>
        <div style={{textAlign:'center'}}>
          <div style={{fontSize:10,fontWeight:700,letterSpacing:'0.1em',textTransform:'uppercase',color:'rgba(60,60,67,0.6)',marginBottom:4}}>Maximum</div>
          <div style={{fontSize:18,fontWeight:700,color:'#000000',}}>{fmtSalary(max)}</div>
        </div>
      </div>
      <div style={{marginBottom:8}}>
        <label style={{fontSize:11,color:'rgba(60,60,67,0.6)',display:'block',marginBottom:4}}>Min salary</label>
        <input type="range" min={MIN_VAL} max={MAX_VAL} step={STEP} value={min}
          onChange={e=>{const v=Number(e.target.value);if(v<=max)onChange(v,max);}}
          style={{width:'100%',accentColor:'#007AFF'}}/>
      </div>
      <div>
        <label style={{fontSize:11,color:'rgba(60,60,67,0.6)',display:'block',marginBottom:4}}>Max salary</label>
        <input type="range" min={MIN_VAL} max={MAX_VAL} step={STEP} value={max}
          onChange={e=>{const v=Number(e.target.value);if(v>=min)onChange(min,v);}}
          style={{width:'100%',accentColor:'#007AFF'}}/>
      </div>
      {min===0&&<p style={{fontSize:11,color:'#FF9500',marginTop:8}}>$0 = Volunteer / Internship included</p>}
    </div>
  );
}


// ── Setup Wizard ───────────────────────────────────────────────────────────
function SetupWizard({initialProfile,initialAnthropicKey,initialSerperKey,initialProvider,onComplete,onClose,onOpenHowTo}:{
  initialProfile:CandidateProfile;
  initialAnthropicKey:string;
  initialSerperKey:string;
  initialProvider:AIProvider;
  onComplete:(p:CandidateProfile,anthKey:string,serpKey:string,provider:AIProvider)=>void;
  onClose:()=>void;
  onOpenHowTo:()=>void;
}) {
  const [step,setStep]=useState(0);
  const [maxVisitedStep,setMaxVisitedStep]=useState(0);

  // Wrap setStep to track max visited
  const goToStep=(n:number)=>{
    setStep(n);
    setMaxVisitedStep(m=>Math.max(m,n));
  };
  const [profile,setProfile]=useState<CandidateProfile>({...initialProfile});
  // Initialize with the key for the CURRENT provider, not a generic key.
  const [wizAnthropicKey,setWizAnthropicKey]=useState(()=>getApiKey(initialProvider)||initialAnthropicKey);
  const [wizSerperKey,setWizSerperKey]=useState(initialSerperKey);
  const [wizProvider,setWizProvider]=useState<AIProvider>(initialProvider);

  // Reload keys from per-provider storage when wizard opens
  useEffect(()=>{
    const storedKey=getApiKey(wizProvider);
    const storedSerper=getLocalSerperKey();
    const storedProvider=getAIProvider();
    if(storedKey) setWizAnthropicKey(storedKey);
    if(storedSerper&&!wizSerperKey) setWizSerperKey(storedSerper);
    if(storedProvider) setWizProvider(storedProvider);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);
  const [uploading,setUploading]=useState(false);
  const [uploadMsg,setUploadMsg]=useState('');
  const [extracting,setExtracting]=useState(false);
  const [extractedFields,setExtractedFields]=useState<Set<string>>(new Set());
  const [newLinkTitle,setNewLinkTitle]=useState('');
  const [newLinkUrl,setNewLinkUrl]=useState('');
  const [linkStep,setLinkStep]=useState<'title'|'url'>('title');
  const [newTitle,setNewTitle]=useState('');
  const [newLocation,setNewLocation]=useState('');
  const [locationError,setLocationError]=useState('');
  const [newSector,setNewSector]=useState('');
  const fileRef=useRef<HTMLInputElement>(null);
  const coverFileRef=useRef<HTMLInputElement>(null);
  const [coverUploadMsg,setCoverUploadMsg]=useState('');
  const existingResumeMeta=getUploadedResumeMeta();
  const existingCoverMeta=getUploadedCoverMeta();
  const [wizResumeMeta,setWizResumeMeta]=useState(existingResumeMeta);
  const [wizCoverMeta,setWizCoverMeta]=useState(existingCoverMeta);
  // Store raw resume text for extraction on Next
  const resumeTextRef=useRef<string>('');

  const TOTAL_STEPS=8; // Increased from 7 to 8 for provider selection
  const pct=Math.round(((step)/TOTAL_STEPS)*100);

  const anthropicValid=validateAPIKey(wizProvider,wizAnthropicKey);
  const serperValid=wizSerperKey.length>10;
  const keysComplete=anthropicValid&&serperValid;

  // On provider switch, load that provider's stored key (if any).
  // This auto-populates the API key field when toggling between Claude/Gemini
  // when keys for both providers have been saved previously.
  // User can still edit — the edited value will persist on save.
  useEffect(()=>{
    const storedForProvider=getApiKey(wizProvider);
    setWizAnthropicKey(storedForProvider);
  },[wizProvider]);

  const upd=(k:keyof CandidateProfile,v:CandidateProfile[keyof CandidateProfile])=>
    setProfile(p=>({...p,[k]:v}));

  // Store resume file on upload but do NOT extract yet.
  // Clear extraction signature so the next "Next" click forces re-extraction.
  const handleResumeUpload=async(file:File)=>{
    setUploading(true);
    try{
      const text=await parseFile(file);
      const dataUri=await fileToDataUri(file);
      resumeTextRef.current=text;
      const ext=file.name.split('.').pop()?.toLowerCase() as UploadMeta['fileType'];
      const meta={filename:file.name,uploadedAt:new Date().toISOString(),fileType:ext};
      setUploadedResume(text,meta);
      setUploadedResumeFileData(dataUri);
      setWizResumeMeta(meta);
      // Invalidate prior extraction — new resume requires re-extraction
      clearStoredExtractionSignature();
      setExtractedFields(new Set());
      setUploadMsg('✓ Resume ready');
    }catch(e:unknown){setUploadMsg(e instanceof Error?e.message:'Upload failed');}
    finally{setUploading(false);}
  };

  // Extract on Next click at resume step — runs extraction then advances.
  // CRITICAL: Re-extracts whenever the resume content, provider, or API key has changed
  // since the last successful extraction. Override = wipe extractedFields + re-run.
  const extractAndAdvance=async()=>{
    const text=resumeTextRef.current||getUploadedResume();
    const meta=wizResumeMeta||getUploadedResumeMeta();
    const filename=meta?.filename||'';

    if(!text){
      setUploadMsg('⚠ No text extracted from resume. Your PDF may be image-based (scanned). Try uploading an HTML or DOCX version instead.');
      goToStep(step+1);
      return;
    }

    // Compute current signature; compare to stored
    const currentSig=computeExtractionSignature(text,filename,wizProvider,wizAnthropicKey);
    const storedSig=getStoredExtractionSignature();
    const stale=isExtractionStale(currentSig,storedSig);

    // If extraction is fresh AND profile already has data from prior run, skip
    if(!stale && profile.name && profile.email){
      goToStep(step+1);
      return;
    }

    // Stale (or first run): force re-extraction. Clear previous extraction markers.
    setExtractedFields(new Set());
    setExtracting(true);
    setUploadMsg('');
    try{
      const fileData=getUploadedResumeFileData();
      const requestBody: Record<string, unknown> = {
        apiKeyOverride:wizAnthropicKey,
        aiProvider:wizProvider
      };

      if(wizProvider==='gemini' && fileData){
        requestBody.fileId=fileData;
      }else{
        requestBody.resumeText=text;
      }

      const res=await fetch('/ape/api/extract-profile',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify(requestBody),
      });
      const data=await safeJson(res);
      if(!res.ok){
        setUploadMsg(`⚠ Extraction failed: ${(data.error as string)||'Unknown error'}. You can fill in your profile manually.`);
        setExtracting(false);
        goToStep(step+1);
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ex: any =(data.profile as Record<string,unknown>)||{};
      const found=new Set<string>();
      // OVERRIDE: do not merge with previous profile fields — replace them
      // so a provider/key change cannot leave stale data from the prior extraction.
      setProfile(p=>{
        const next={...p};
        const setField=(key:keyof CandidateProfile,val:unknown,allowEmpty=false)=>{
          if(allowEmpty||(val&&(Array.isArray(val)?val.length>0:String(val).trim()))){
            (next as Record<string,unknown>)[key]=val;
            if(val&&(Array.isArray(val)?val.length>0:String(val).trim())) found.add(key);
          }
        };
        setField('name',ex.name);
        setField('email',ex.email);
        setField('phone',ex.phone);
        // URLs — explicitly REPLACE prior values (clear if missing) to prevent
        // stale hallucinated URLs from a previous provider lingering.
        next.linkedinUrl=ex.linkedinUrl||'';
        if(ex.linkedinUrl) found.add('linkedinUrl');
        next.portfolioUrl=ex.portfolioUrl||'';
        if(ex.portfolioUrl) found.add('portfolioUrl');
        setField('mostRecentRole',ex.mostRecentRole);
        setField('mostRecentEmployer',ex.mostRecentEmployer);
        setField('yearsExperience',ex.yearsExperience);
        setField('coreStrengths',ex.coreStrengths);
        setField('discipline',ex.discipline);
        // Arrays — REPLACE (not merge) so old targets don't bleed through
        next.targetTitles=Array.isArray(ex.targetTitles)?ex.targetTitles:[];
        if(next.targetTitles.length) found.add('targetTitles');
        next.targetSectors=Array.isArray(ex.targetSectors)?ex.targetSectors:[];
        if(next.targetSectors.length) found.add('targetSectors');
        next.salaryMin=ex.salaryMin>0?ex.salaryMin:0;
        next.salaryMax=ex.salaryMax>0?ex.salaryMax:0;
        if(next.salaryMin>0||next.salaryMax>0) found.add('salaryMin');
        // Additional links — REPLACE entirely from latest extraction
        next.additionalLinks=Array.isArray(ex.additionalLinks)?ex.additionalLinks.filter((l:{url?:string})=>l&&l.url):[];
        if(next.additionalLinks.length) found.add('additionalLinks');
        return next;
      });
      setExtractedFields(found);
      // Persist signature only on successful extraction
      setStoredExtractionSignature(currentSig);
    }catch(e:unknown){
      setUploadMsg(`⚠ Connection error: ${e instanceof Error?e.message:'Unknown error'}. Fill in your profile manually.`);
    }
    finally{setExtracting(false);}
    goToStep(step+1);
  };

  const addLink=()=>{
    if(linkStep==='title'){if(newLinkTitle.trim())setLinkStep('url');}
    else{
      if(newLinkUrl.trim()){
        upd('additionalLinks',[...profile.additionalLinks,{title:newLinkTitle.trim(),url:newLinkUrl.trim()}]);
        setNewLinkTitle('');setNewLinkUrl('');setLinkStep('title');
      }
    }
  };
  const removeLink=(i:number)=>upd('additionalLinks',profile.additionalLinks.filter((_,idx)=>idx!==i));
  const addTargetTitle=()=>{
    if(newTitle.trim()&&!profile.targetTitles.includes(newTitle.trim())){
      upd('targetTitles',[...profile.targetTitles,newTitle.trim()]);setNewTitle('');
    }
  };
  const removeTargetTitle=(t:string)=>upd('targetTitles',profile.targetTitles.filter(x=>x!==t));
  const addLocation=()=>{
    const val=newLocation.trim();
    if(!val) return;
    const check=validateLocationInput(val);
    if(!check.valid){setLocationError(check.error||'Invalid location.');return;}
    if(!profile.locations.includes(val)){
      upd('locations',[...profile.locations,val]);setNewLocation('');setLocationError('');
    } else {
      setNewLocation('');setLocationError('');
    }
  };
  const removeLocation=(l:string)=>upd('locations',profile.locations.filter(x=>x!==l));
  const toggleWorkType=(wt:string)=>{
    const cur=profile.workTypes;
    upd('workTypes',cur.includes(wt)?cur.filter(x=>x!==wt):[...cur,wt]);
  };

  const finish=()=>{
    // Save key to PROVIDER-SPECIFIC slot, not generic slot.
    // This ensures both Claude and Gemini keys persist independently.
    setApiKey(wizProvider,wizAnthropicKey);
    setLocalSerperKey(wizSerperKey);
    setAIProvider(wizProvider);
    saveProfile(profile);
    const js=buildJobSearchInstructions(profile);
    const res=buildResumeInstructions(profile);
    const cv=buildCoverLetterInstructions(profile);
    saveInstructions({jobSearch:js,resume:res,coverLetter:cv});
    onComplete(profile,wizAnthropicKey,wizSerperKey,wizProvider);
  };

  const inp=(style?:React.CSSProperties):React.CSSProperties=>({
    width:'100%',padding:'12px 12px',border:'0.5px solid rgba(60,60,67,0.2)',
    borderRadius:10,fontSize:16,outline:'none',minHeight:44,...style
  });
  const lbl:React.CSSProperties={fontSize:10,fontWeight:700,letterSpacing:'0.15em',textTransform:'uppercase',color:'rgba(60,60,67,0.6)',marginBottom:6,display:'block'};

  // Key field with inline validation indicator
  const KeyField=({label,value,onChange,valid,placeholder,note}:{
    label:string;value:string;onChange:(v:string)=>void;
    valid:boolean;placeholder:string;note:string;
  })=>(
    <div style={{marginBottom:18}}>
      <label style={lbl}>{label}</label>
      <div style={{position:'relative'}}>
        <input
          type="text"
          value={value}
          onChange={e=>onChange(e.target.value)}
          placeholder={placeholder}
          style={{...inp(),paddingRight:40,fontFamily:'monospace',fontSize:13,
            borderColor:value.length>0?(valid?'#1A7A3C':'#007AFF'):'rgba(60,60,67,0.2)'}}
        />
        {value.length>0&&(
          <div style={{position:'absolute',right:12,top:'50%',transform:'translateY(-50%)'}}>
            {valid
              ?<CheckCircle size={16} color="#1A7A3C" fill="rgba(52,199,89,0.12)"/>
              :<AlertTriangle size={16} color="#007AFF"/>
            }
          </div>
        )}
      </div>
      {value.length>0&&!valid&&(
        <div style={{fontSize:11,color:'#007AFF',marginTop:4,display:'flex',alignItems:'center',gap:4}}>
          <AlertTriangle size={11}/>{note}
        </div>
      )}
      {value.length>0&&valid&&(
        <div style={{fontSize:11,color:'#1A7A3C',marginTop:4,display:'flex',alignItems:'center',gap:4}}>
          <CheckCircle size={11}/>Key format looks valid
        </div>
      )}
    </div>
  );

  const stepContent=()=>{
    switch(step){
      // ── STEP 0: PROVIDER SELECTION ───────────────────────────────────────────
      case 0: return (
        <div>
          <h2 style={{fontSize:24,marginBottom:8}}>Choose Your AI Provider</h2>
          <p style={{fontSize:14,color:'rgba(60,60,67,0.6)',lineHeight:1.7,marginBottom:24}}>
            Select which AI service you'd like to use. You can change this anytime in Settings.
          </p>

          <div style={{display:'flex',flexDirection:'column',gap:12}}>
            {/* Claude option */}
            <button
              onClick={()=>setWizProvider('claude')}
              style={{
                background:wizProvider==='claude'?'rgba(0,122,255,0.1)':'#F2F2F7',
                border:wizProvider==='claude'?'2px solid #007AFF':'2px solid transparent',
                borderRadius:14,
                padding:20,
                textAlign:'left',
                cursor:'pointer',
                transition:'all 0.2s',
              }}
            >
              <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:8}}>
                <div>
                  <h3 style={{fontSize:17,fontWeight:700,color:'#000',marginBottom:4}}>Claude (Anthropic)</h3>
                  <p style={{fontSize:13,color:'rgba(60,60,67,0.7)',lineHeight:1.6}}>
                    Advanced reasoning and instruction following. Requires credit ($5–10 minimum).
                  </p>
                </div>
                {wizProvider==='claude'&&<CheckCircle size={20} color="#007AFF" fill="#007AFF"/>}
              </div>
            </button>

            {/* Gemini option */}
            <button
              onClick={()=>setWizProvider('gemini')}
              style={{
                background:wizProvider==='gemini'?'rgba(0,122,255,0.1)':'#F2F2F7',
                border:wizProvider==='gemini'?'2px solid #007AFF':'2px solid transparent',
                borderRadius:14,
                padding:20,
                textAlign:'left',
                cursor:'pointer',
                transition:'all 0.2s',
              }}
            >
              <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:8}}>
                <div>
                  <h3 style={{fontSize:17,fontWeight:700,color:'#000',marginBottom:4}}>Gemini (Google)</h3>
                  <p style={{fontSize:13,color:'rgba(60,60,67,0.7)',lineHeight:1.6}}>
                    Fast and capable. Generous free tier available.
                  </p>
                </div>
                {wizProvider==='gemini'&&<CheckCircle size={20} color="#007AFF" fill="#007AFF"/>}
              </div>
            </button>
          </div>

          <div style={{marginTop:20,padding:14,background:'rgba(0,122,255,0.05)',borderRadius:10,fontSize:12,color:'rgba(60,60,67,0.7)',lineHeight:1.6}}>
            💡 <strong>Tip:</strong> Both providers work great. Choose based on your budget and API access.
          </div>
        </div>
      );

      // ── STEP 1: API KEYS ──────────────────────────────────────────────────
      case 1: return (
        <div>
          <h2 style={{fontSize:24,marginBottom:6}}>Set Up Your API Keys</h2>
          <p style={{fontSize:14,color:'rgba(60,60,67,0.65)',lineHeight:1.7,marginBottom:4}}>
            This app uses two external APIs to find and generate your job application materials. Both are required.
          </p>
          <button onClick={onOpenHowTo} style={{display:'inline-flex',alignItems:'center',gap:5,fontSize:12,color:'#007AFF',background:'none',border:'none',cursor:'pointer',padding:'0 0 16px 0',textDecoration:'underline'}}>
            <HelpCircle size={13}/>See full setup guide in How to Use
          </button>

          {/* AI Provider card */}
          <div style={{background:'#F2F2F7',borderRadius:14,padding:18,marginBottom:16,border:'0.5px solid #e8e4da'}}>
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:12}}>
              <div>
                <div style={{fontSize:13,fontWeight:700,color:'#000000',marginBottom:2}}>1. {getProviderName(wizProvider)} API Key</div>
                <div style={{fontSize:11,color:'rgba(60,60,67,0.6)'}}>Powers AI search processing and document generation</div>
              </div>
              <a href={getProviderSetupURL(wizProvider)} target="_blank" rel="noreferrer"
                style={{display:'flex',alignItems:'center',gap:5,padding:'7px 12px',background:'#000000',color:'#fff',borderRadius:10,fontSize:12,fontWeight:700,textDecoration:'none',whiteSpace:'nowrap'}}>
                Get Key <ExternalLink size={11}/>
              </a>
            </div>
            <div style={{fontSize:12,color:'rgba(60,60,67,0.85)',lineHeight:1.8,marginBottom:14}}>
              <div style={{fontWeight:700,fontSize:11,letterSpacing:'0.1em',textTransform:'uppercase',color:'rgba(60,60,67,0.6)',marginBottom:6}}>Steps to get your key:</div>
              <ol style={{paddingLeft:18,display:'flex',flexDirection:'column',gap:4}}>
                {getProviderSetupSteps(wizProvider).map((step,i)=>(
                  <li key={i} dangerouslySetInnerHTML={{__html:step.replace(/console\.anthropic\.com\/settings\/keys/g,'<a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer" style="color:#007AFF">console.anthropic.com/settings/keys</a>').replace(/aistudio\.google\.com\/app\/apikey/g,'<a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" style="color:#007AFF">aistudio.google.com/app/apikey</a>')}}/>
                ))}
              </ol>
            </div>
            <KeyField
              label={`${getProviderName(wizProvider)} API Key`}
              value={wizAnthropicKey}
              onChange={setWizAnthropicKey}
              valid={anthropicValid}
              placeholder={getAPIKeyPlaceholder(wizProvider)}
              note={getAPIKeyNote(wizProvider)}
            />
            <button onClick={()=>goToStep(0)} style={{marginTop:10,fontSize:12,color:'#007AFF',background:'none',border:'none',cursor:'pointer',textDecoration:'underline'}}>
              ← Change provider
            </button>
          </div>

          {/* Serper card (unchanged) */}
          <div style={{background:'#F2F2F7',borderRadius:14,padding:18,border:'0.5px solid #e8e4da'}}>
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:12}}>
              <div>
                <div style={{fontSize:13,fontWeight:700,color:'#000000',marginBottom:2}}>2. Serper API Key</div>
                <div style={{fontSize:11,color:'rgba(60,60,67,0.6)'}}>Powers live Google job search results (2,500 free searches/month)</div>
              </div>
              <a href="https://serper.dev/api-key" target="_blank" rel="noreferrer"
                style={{display:'flex',alignItems:'center',gap:5,padding:'7px 12px',background:'#000000',color:'#fff',borderRadius:10,fontSize:12,fontWeight:700,textDecoration:'none',whiteSpace:'nowrap'}}>
                Get Key <ExternalLink size={11}/>
              </a>
            </div>
            <div style={{fontSize:12,color:'rgba(60,60,67,0.85)',lineHeight:1.8,marginBottom:14}}>
              <div style={{fontWeight:700,fontSize:11,letterSpacing:'0.1em',textTransform:'uppercase',color:'rgba(60,60,67,0.6)',marginBottom:6}}>Steps to get your key:</div>
              <ol style={{paddingLeft:18,display:'flex',flexDirection:'column',gap:4}}>
                <li>Go to <a href="https://serper.dev" target="_blank" rel="noreferrer" style={{color:'#007AFF'}}>serper.dev</a> in a new tab</li>
                <li>Click <strong>"Get Started"</strong> and create a free account</li>
                <li>After signing in, go to <a href="https://serper.dev/api-key" target="_blank" rel="noreferrer" style={{color:'#007AFF'}}>serper.dev/api-key</a></li>
                <li>Copy your API key from the dashboard</li>
                <li>Paste it below — no credit card required for the free tier</li>
              </ol>
            </div>
            <KeyField
              label="Serper API Key"
              value={wizSerperKey}
              onChange={setWizSerperKey}
              valid={serperValid}
              placeholder="Paste your Serper API key..."
              note="Key appears too short — make sure you copied the full key from the dashboard"
            />
          </div>
        </div>
      );

      // ── STEP 2: RESUME (was Step 1) ───────────────────────────────────────
      case 2: return (
        <div>
          <h2 style={{fontSize:24,marginBottom:8}}>Upload Your Documents</h2>
          <p style={{fontSize:14,color:'rgba(60,60,67,0.6)',lineHeight:1.7,marginBottom:20}}>
            Upload your resume and cover letter. We'll extract your profile automatically. Supports HTML, DOCX, and text-based PDF.
          </p>

          {/* Resume upload */}
          <div style={{marginBottom:20}}>
            <div style={{fontSize:11,fontWeight:700,letterSpacing:'0.15em',textTransform:'uppercase',color:'rgba(60,60,67,0.6)',marginBottom:8,display:'flex',alignItems:'center',gap:6}}><FileText size={12}/>Resume</div>
            <input ref={fileRef} type="file" accept=".html,.htm,.pdf,.docx" style={{display:'none'}}
              onChange={e=>{const f=e.target.files?.[0];if(f){handleResumeUpload(f).then(()=>setWizResumeMeta(getUploadedResumeMeta()));}}}/>
            <div onClick={()=>fileRef.current?.click()} style={{border:`2px dashed ${(wizResumeMeta||uploadMsg.startsWith('✓'))?'#1A7A3C':'rgba(60,60,67,0.2)'}`,borderRadius:10,padding:'20px 24px',textAlign:'center',cursor:'pointer',background:(wizResumeMeta||uploadMsg.startsWith('✓'))?'#f0faf5':'#fff'}}>
              <Upload size={26} color={(wizResumeMeta||uploadMsg.startsWith('✓'))?'#1A7A3C':'rgba(60,60,67,0.6)'} style={{marginBottom:8}}/>
              <div style={{fontWeight:700,fontSize:14,marginBottom:3,color:'#000',letterSpacing:'-0.01em'}}>Choose Resume File</div>
              <div style={{fontSize:11,color:'rgba(60,60,67,0.6)'}}>HTML · DOCX · PDF (text-based)</div>
            </div>
            {uploading&&<div style={{fontSize:12,color:'#FF9500',display:'flex',alignItems:'center',gap:6,marginTop:8}}><Clock size={13}/>Extracting profile data...</div>}
            {!uploading&&wizResumeMeta&&(
              <div style={{display:'flex',alignItems:'center',gap:5,background:'rgba(52,199,89,0.12)',borderRadius:10,padding:'7px 10px',marginTop:8}}>
                <CheckCircle size={12} color="#1A7A3C" fill="#1A7A3C"/>
                <div style={{flex:1,textAlign:'left'}}>
                  <div style={{fontSize:11,fontWeight:700,color:'#1A7A3C'}}>{wizResumeMeta.filename}</div>
                  <div style={{fontSize:10,color:'rgba(26,122,60,0.7)'}}>Loaded {fmtDateTime(wizResumeMeta.uploadedAt)}</div>
                </div>
                <button onClick={e=>{e.stopPropagation();fileRef.current?.click();}} style={{background:'none',border:'none',cursor:'pointer',fontSize:11,color:'rgba(60,60,67,0.6)',textDecoration:'underline'}}>Re-upload</button>
              </div>
            )}
            {!uploading&&!wizResumeMeta&&uploadMsg&&<div style={{fontSize:12,color:uploadMsg.startsWith('✓')?'#1A7A3C':'#007AFF',marginTop:8,display:'flex',alignItems:'center',gap:5}}><CheckCircle size={13}/>{uploadMsg}</div>}
          </div>

          {/* Cover letter upload */}
          <div style={{borderTop:'0.5px solid rgba(60,60,67,0.2)',paddingTop:20,marginBottom:16}}>
            <div style={{fontSize:11,fontWeight:700,letterSpacing:'0.15em',textTransform:'uppercase',color:'rgba(60,60,67,0.6)',marginBottom:8,display:'flex',alignItems:'center',gap:6}}><Mail size={12}/>Cover Letter</div>
            <input ref={coverFileRef} type="file" accept=".html,.htm,.pdf,.docx" style={{display:'none'}}
              onChange={async e=>{
                const f=e.target.files?.[0]; if(!f) return;
                setCoverUploadMsg('Storing file...');
                try{
                  const text=await parseFile(f);
                  const dataUri=await fileToDataUri(f);
                  const ext=f.name.split('.').pop()?.toLowerCase() as UploadMeta['fileType'];
                  const meta={filename:f.name,uploadedAt:new Date().toISOString(),fileType:ext};
                  setUploadedCover(text,meta);
                  setUploadedCoverFileData(dataUri);
                  setWizCoverMeta(meta);
                  setCoverUploadMsg('✓ Cover letter stored');
                }catch(err:unknown){setCoverUploadMsg(err instanceof Error?err.message:'Upload failed');}
              }}/>
            <div onClick={()=>wizCoverMeta?undefined:coverFileRef.current?.click()} style={{border:`2px dashed ${wizCoverMeta?'#1A7A3C':'rgba(60,60,67,0.2)'}`,borderRadius:10,padding:'20px 24px',textAlign:'center',cursor:wizCoverMeta?'default':'pointer',background:wizCoverMeta?'#f0faf5':'#fff'}}>
              <Upload size={26} color={wizCoverMeta?'#1A7A3C':'rgba(60,60,67,0.6)'} style={{marginBottom:8}}/>
              <div style={{fontWeight:700,fontSize:14,marginBottom:3,color:'#000',letterSpacing:'-0.01em'}}>Choose Cover Letter File</div>
              <div style={{fontSize:11,color:'rgba(60,60,67,0.6)'}}>HTML · DOCX · PDF (text-based)</div>
            </div>
            {wizCoverMeta&&(
              <div style={{display:'flex',alignItems:'center',gap:5,background:'rgba(52,199,89,0.12)',borderRadius:10,padding:'7px 10px',marginTop:8}}>
                <CheckCircle size={12} color="#1A7A3C" fill="#1A7A3C"/>
                <div style={{flex:1,textAlign:'left'}}>
                  <div style={{fontSize:11,fontWeight:700,color:'#1A7A3C'}}>{wizCoverMeta.filename}</div>
                  <div style={{fontSize:10,color:'rgba(26,122,60,0.7)'}}>Loaded {fmtDateTime(wizCoverMeta.uploadedAt)}</div>
                </div>
                <button onClick={e=>{e.stopPropagation();coverFileRef.current?.click();}} style={{background:'none',border:'none',cursor:'pointer',fontSize:11,color:'rgba(60,60,67,0.6)',textDecoration:'underline'}}>Re-upload</button>
              </div>
            )}
            {!wizCoverMeta&&coverUploadMsg&&<div style={{fontSize:12,color:coverUploadMsg.startsWith('✓')?'#1A7A3C':'#007AFF',marginTop:8,display:'flex',alignItems:'center',gap:5}}><CheckCircle size={13}/>{coverUploadMsg}</div>}
          </div>

          <button onClick={()=>goToStep(2)} style={{fontSize:13,color:'rgba(60,60,67,0.6)',background:'none',border:'none',cursor:'pointer',textDecoration:'underline'}}>
            Skip — fill in manually
          </button>
        </div>
      );


      // ── STEP 3: PROFILE ──────────────────────────────────────────────────
      case 3: {
        const didNotFind=(k:string)=>extractedFields.size>0&&!extractedFields.has(k);
        const hint=(k:string)=>didNotFind(k)?(
          <div style={{fontSize:10,color:'#FF9500',marginTop:3,display:'flex',alignItems:'center',gap:3}}>
            <AlertTriangle size={10}/>Did not find in resume
          </div>
        ):null;
        return (
          <div>
            <h2 style={{fontSize:24,marginBottom:8}}>Your Information</h2>
            <p style={{fontSize:14,color:'rgba(60,60,67,0.65)',marginBottom:4}}>Review and confirm your details. Fields marked below were not found in your resume.</p>
            {extractedFields.size>0&&<p style={{fontSize:12,color:'#1A7A3C',marginBottom:16,display:'flex',alignItems:'center',gap:5}}><CheckCircle size={13} fill="#1A7A3C" color="#1A7A3C"/>Extracted {extractedFields.size} fields from your resume</p>}
            <div style={{display:'grid',gap:14}}>
              {([
                ['name','Full Name','text'],['email','Email','email'],['phone','Phone','text'],
                ['mostRecentRole','Most Recent Job Title','text'],['mostRecentEmployer','Most Recent Employer','text'],
                ['yearsExperience','Years of Experience','text'],
              ] as [keyof CandidateProfile,string,string][]).map(([k,label,type])=>(
                <div key={k}>
                  <label style={lbl}>{label}</label>
                  <input type={type} value={profile[k] as string} onChange={e=>upd(k,e.target.value)} style={inp()}/>
                  {hint(k)}
                </div>
              ))}
              <div>
                <label style={lbl}>Discipline / Field</label>
                <input type="text" value={profile.discipline||''} onChange={e=>upd('discipline',e.target.value)} style={inp()} placeholder="e.g. UX Design, Product Management, Engineering"/>
                {hint('discipline')}
                <div style={{fontSize:11,color:'rgba(60,60,67,0.6)',marginTop:4}}>Used to personalize recruiter framing in your search instructions.</div>
              </div>
              <div>
                <label style={lbl}>Core Strengths</label>
                <input type="text" value={profile.coreStrengths} onChange={e=>upd('coreStrengths',e.target.value)} style={inp()} placeholder="e.g. E-commerce, Enterprise SaaS, Design Systems"/>
                {hint('coreStrengths')}
              </div>
            </div>
          </div>
        );
      }

      // ── STEP 4: LINKS ────────────────────────────────────────────────────
      case 4: return (
        <div>
          <h2 style={{fontSize:24,marginBottom:8}}>Your Links</h2>
          <p style={{fontSize:14,color:'rgba(60,60,67,0.65)',marginBottom:20}}>Add your professional links. These appear in all instructions and generated documents.</p>
          {extractedFields.size>0&&profile.linkedinUrl&&<div style={{fontSize:12,color:'#1A7A3C',marginBottom:12,display:'flex',alignItems:'center',gap:5}}><CheckCircle size={13} fill="#1A7A3C" color="#1A7A3C"/>Links extracted from resume — review below</div>}
          <div style={{display:'grid',gap:12,marginBottom:20}}>
            <div>
              <label style={lbl}>LinkedIn URL</label>
              <input type="text" value={profile.linkedinUrl} onChange={e=>upd('linkedinUrl',e.target.value)} style={inp()} placeholder="linkedin.com/in/username"/>
              {extractedFields.size>0&&!extractedFields.has('linkedinUrl')&&<div style={{fontSize:10,color:'#FF9500',marginTop:3,display:'flex',alignItems:'center',gap:3}}><AlertTriangle size={10}/>Did not find in resume</div>}
            </div>
            <div>
              <label style={lbl}>Portfolio URL</label>
              <input type="text" value={profile.portfolioUrl} onChange={e=>upd('portfolioUrl',e.target.value)} style={inp()} placeholder="yourportfolio.com"/>
              {extractedFields.size>0&&!extractedFields.has('portfolioUrl')&&<div style={{fontSize:10,color:'#FF9500',marginTop:3,display:'flex',alignItems:'center',gap:3}}><AlertTriangle size={10}/>Did not find in resume</div>}
            </div>
          </div>
          <div style={{borderTop:'0.5px solid rgba(60,60,67,0.2)',paddingTop:16,marginBottom:12}}>
            <label style={lbl}>Additional Links</label>
            {profile.additionalLinks.map((l,i)=>(
              <div key={i} style={{background:'#F2F2F7',borderRadius:10,padding:'10px 12px',marginBottom:8,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <div>
                  <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',letterSpacing:'0.1em',color:'#007AFF',marginBottom:2}}>{l.title}</div>
                  <div style={{fontSize:13,color:'rgba(60,60,67,0.85)'}}>{l.url}</div>
                </div>
                <button onClick={()=>removeLink(i)} style={{background:'none',border:'none',cursor:'pointer',color:'#007AFF'}}><X size={16}/></button>
              </div>
            ))}
            <div style={{background:'#fff',border:'0.5px solid rgba(60,60,67,0.2)',borderRadius:10,padding:14}}>
              {linkStep==='title'?(
                <div>
                  <label style={lbl}>Link Title</label>
                  <div style={{display:'flex',gap:8}}>
                    <input type="text" value={newLinkTitle} onChange={e=>setNewLinkTitle(e.target.value)} onKeyDown={e=>e.key==='Enter'&&addLink()} style={inp({flex:'1',marginBottom:0})} placeholder="e.g. Dribbble, GitHub, Case Studies"/>
                    <button onClick={addLink} disabled={!newLinkTitle.trim()} style={{padding:'10px 14px',background:'#000000',color:'#fff',border:'none',borderRadius:10,cursor:'pointer',fontWeight:600,fontSize:13,display:'flex',alignItems:'center',gap:5}}>Next<ChevronRight size={14}/></button>
                  </div>
                </div>
              ):(
                <div>
                  <div style={{fontSize:12,fontWeight:700,color:'#007AFF',marginBottom:8}}>"{newLinkTitle}" URL</div>
                  <div style={{display:'flex',gap:8}}>
                    <input type="text" value={newLinkUrl} onChange={e=>setNewLinkUrl(e.target.value)} onKeyDown={e=>e.key==='Enter'&&addLink()} style={inp({flex:'1',marginBottom:0})} placeholder="https://..."/>
                    <button onClick={addLink} disabled={!newLinkUrl.trim()} style={{padding:'10px 14px',background:'#000000',color:'#fff',border:'none',borderRadius:10,cursor:'pointer',fontWeight:600,fontSize:13,display:'flex',alignItems:'center',gap:5}}><Plus size={14}/>Add</button>
                    <button onClick={()=>{setLinkStep('title');setNewLinkUrl('');}} style={{padding:'10px 12px',border:'0.5px solid rgba(60,60,67,0.2)',borderRadius:10,background:'transparent',cursor:'pointer'}}><ChevronLeft size={14}/></button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      );

      // ── STEP 5: TITLES ───────────────────────────────────────────────────
      case 5: return (
        <div>
          <h2 style={{fontSize:24,marginBottom:8}}>Target Job Titles</h2>
          <p style={{fontSize:14,color:'rgba(60,60,67,0.65)',marginBottom:8}}>What roles are you targeting? These drive your search queries.</p>
          {extractedFields.has('targetTitles')&&profile.targetTitles.length>0&&<div style={{fontSize:12,color:'#1A7A3C',marginBottom:12,display:'flex',alignItems:'center',gap:5}}><CheckCircle size={13} fill="#1A7A3C" color="#1A7A3C"/>Suggested from your resume — includes titles one level above your most recent role</div>}
          {extractedFields.size>0&&!extractedFields.has('targetTitles')&&<div style={{fontSize:12,color:'#FF9500',marginBottom:12,display:'flex',alignItems:'center',gap:5}}><AlertTriangle size={12}/>Did not find target titles in resume — add them below</div>}
          <div style={{display:'flex',flexWrap:'wrap',gap:8,marginBottom:16}}>
            {profile.targetTitles.map(t=>(
              <span key={t} style={{display:'flex',alignItems:'center',gap:5,background:'#000000',color:'#F2F2F7',fontSize:12,fontWeight:600,padding:'5px 10px',borderRadius:4}}>
                {t}<button onClick={()=>removeTargetTitle(t)} style={{background:'none',border:'none',cursor:'pointer',color:'rgba(255,255,255,0.6)',padding:0,display:'flex'}}><X size={12}/></button>
              </span>
            ))}
          </div>
          <div style={{display:'flex',gap:8}}>
            <input type="text" value={newTitle} onChange={e=>setNewTitle(e.target.value)} onKeyDown={e=>e.key==='Enter'&&addTargetTitle()} style={inp({flex:'1',marginBottom:0})} placeholder="e.g. VP of Design"/>
            <button onClick={addTargetTitle} disabled={!newTitle.trim()} style={{padding:'10px 14px',background:'#000000',color:'#fff',border:'none',borderRadius:10,cursor:'pointer',fontWeight:600,fontSize:13,display:'flex',alignItems:'center',gap:5}}><Plus size={14}/>Add</button>
          </div>

          <div style={{borderTop:'0.5px solid rgba(60,60,67,0.2)',paddingTop:20,marginTop:20}}>
            <label style={lbl}>Target Sectors / Industries</label>
            {extractedFields.has('targetSectors')&&profile.targetSectors.length>0&&<div style={{fontSize:12,color:'#1A7A3C',marginBottom:8,display:'flex',alignItems:'center',gap:5}}><CheckCircle size={13} fill="#1A7A3C" color="#1A7A3C"/>Extracted from your resume — review below</div>}
            {extractedFields.size>0&&!extractedFields.has('targetSectors')&&<div style={{fontSize:12,color:'#FF9500',marginBottom:8,display:'flex',alignItems:'center',gap:5}}><AlertTriangle size={12}/>Did not find in resume — add your target industries below</div>}
            <div style={{display:'flex',flexWrap:'wrap',gap:8,marginBottom:12}}>
              {(profile.targetSectors||[]).map(s=>(
                <span key={s} style={{display:'flex',alignItems:'center',gap:5,background:'rgba(0,122,255,0.1)',color:'#007AFF',fontSize:12,fontWeight:600,padding:'5px 10px',borderRadius:4}}>
                  {s}<button onClick={()=>upd('targetSectors',(profile.targetSectors||[]).filter(x=>x!==s))} style={{background:'none',border:'none',cursor:'pointer',color:'rgba(26,79,216,0.6)',padding:0,display:'flex'}}><X size={12}/></button>
                </span>
              ))}
            </div>
            <div style={{display:'flex',gap:8}}>
              <input type="text" value={newSector} onChange={e=>setNewSector(e.target.value)}
                onKeyDown={e=>{if(e.key==='Enter'&&newSector.trim()){upd('targetSectors',[...(profile.targetSectors||[]),newSector.trim()]);setNewSector('');}}}
                style={inp({flex:'1',marginBottom:0})} placeholder="e.g. Fintech, Healthcare, SaaS, Retail"/>
              <button onClick={()=>{if(newSector.trim()){upd('targetSectors',[...(profile.targetSectors||[]),newSector.trim()]);setNewSector('');}}} disabled={!newSector.trim()} style={{padding:'10px 14px',background:'#000000',color:'#fff',border:'none',borderRadius:10,cursor:'pointer',fontWeight:600,fontSize:13,display:'flex',alignItems:'center',gap:5}}><Plus size={14}/>Add</button>
            </div>
          </div>
        </div>
      );

      // ── STEP 6: WORK PREFS ───────────────────────────────────────────────
      case 6: return (
        <div>
          <h2 style={{fontSize:24,marginBottom:8}}>Work Preferences</h2>
          <p style={{fontSize:14,color:'rgba(60,60,67,0.65)',marginBottom:20}}>Select your preferred work arrangements and locations.</p>
          <label style={lbl}>Work Type (select all that apply)</label>
          <div style={{display:'flex',gap:10,marginBottom:24,flexWrap:'wrap'}}>
            {[['remote','Remote'],['hybrid','Hybrid'],['onsite','On-site']].map(([val,label])=>(
              <button key={val} onClick={()=>toggleWorkType(val)} style={{padding:'10px 20px',borderRadius:10,fontWeight:700,fontSize:13,cursor:'pointer',border:`2px solid ${profile.workTypes.includes(val)?'#000000':'rgba(60,60,67,0.2)'}`,background:profile.workTypes.includes(val)?'#000000':'transparent',color:profile.workTypes.includes(val)?'#fff':'rgba(60,60,67,0.6)'}}>{label}</button>
            ))}
          </div>
          {(profile.workTypes.includes('hybrid')||profile.workTypes.includes('onsite'))&&(
            <div>
              <label style={lbl}>Acceptable States / Cities</label>
              <div style={{display:'flex',flexWrap:'wrap',gap:6,marginBottom:10}}>
                {profile.locations.map(l=>(
                  <span key={l} style={{display:'flex',alignItems:'center',gap:4,background:'rgba(255,204,0,0.12)',color:'#FF9500',fontSize:12,fontWeight:700,padding:'4px 10px',borderRadius:3}}>
                    <MapPin size={10}/>{l}<button onClick={()=>removeLocation(l)} style={{background:'none',border:'none',cursor:'pointer',color:'#FF9500',padding:0}}><X size={10}/></button>
                  </span>
                ))}
              </div>
              <div style={{display:'flex',gap:8}}>
                <input type="text" value={newLocation} onChange={e=>{setNewLocation(e.target.value);setLocationError('');}} onKeyDown={e=>e.key==='Enter'&&addLocation()} style={inp({flex:'1',marginBottom:0})} placeholder="e.g. AZ, Phoenix AZ, USA"/>
                <button onClick={addLocation} disabled={!newLocation.trim()} style={{padding:'10px 14px',background:'#000000',color:'#fff',border:'none',borderRadius:10,cursor:'pointer',fontWeight:600,fontSize:13,display:'flex',alignItems:'center',gap:5}}><Plus size={14}/>Add</button>
              </div>
              {locationError&&<div style={{fontSize:12,color:'#FF3B30',marginTop:6,display:'flex',alignItems:'center',gap:5}}><AlertTriangle size={12}/>{locationError}</div>}
            </div>
          )}
        </div>
      );

      // ── STEP 7: SALARY ───────────────────────────────────────────────────
      case 7: return (
        <div>
          <h2 style={{fontSize:24,marginBottom:8}}>Salary Range</h2>
          <p style={{fontSize:14,color:'rgba(60,60,67,0.65)',marginBottom:8}}>Set your target compensation range. This filters job results and informs search queries.</p>
          {extractedFields.has('salaryMin')&&(profile.salaryMin>0||profile.salaryMax>0)&&<div style={{fontSize:12,color:'#1A7A3C',marginBottom:12,display:'flex',alignItems:'center',gap:5}}><CheckCircle size={13} fill="#1A7A3C" color="#1A7A3C"/>Salary range extracted from resume — adjust if needed</div>}
          {extractedFields.size>0&&!extractedFields.has('salaryMin')&&<div style={{fontSize:12,color:'#FF9500',marginBottom:12,display:'flex',alignItems:'center',gap:5}}><AlertTriangle size={12}/>Salary not found in resume — set your target range below</div>}
          <SalarySlider min={profile.salaryMin} max={profile.salaryMax} onChange={(mn,mx)=>{upd('salaryMin',mn);upd('salaryMax',mx);}}/>
        </div>
      );

      default: return null;
    }
  };

  const stepLabels=['Provider','API Keys','Resume','Profile','Links','Titles','Work','Salary'];
  const isLastStep=step===TOTAL_STEPS-1;
  const canFinish=keysComplete;

  return (
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.45)',backdropFilter:'blur(12px)',WebkitBackdropFilter:'blur(12px)',zIndex:900,display:'flex',alignItems:'center',justifyContent:'center',padding:20}}>
      <div style={{background:'rgba(255,255,255,0.97)',borderRadius:24,width:'100%',maxWidth:580,maxHeight:'92vh',overflowY:'auto',boxShadow:'0 24px 80px rgba(0,0,0,0.2)',display:'flex',flexDirection:'column',border:'0.5px solid rgba(255,255,255,0.8)'}}>

        {/* Wizard header */}
        <div style={{padding:'18px 22px 14px',borderBottom:'0.5px solid rgba(60,60,67,0.18)',position:'sticky',top:0,background:'rgba(255,255,255,0.97)',backdropFilter:'blur(20px)',WebkitBackdropFilter:'blur(20px)',zIndex:10,borderRadius:'24px 24px 0 0'}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
            <div>
              <div style={{fontSize:10,letterSpacing:'0.15em',textTransform:'uppercase',color:'#007AFF',fontWeight:700,marginBottom:4,display:'flex',alignItems:'center',gap:6}}><Wand2 size={11}/>Guided Setup</div>
              <div style={{fontSize:13,color:'rgba(60,60,67,0.6)'}}>Step {step+1} of {TOTAL_STEPS} — {stepLabels[step]}</div>
            </div>
            <button onClick={onClose} aria-label="Close wizard" style={{background:'rgba(120,120,128,0.12)',border:'none',cursor:'pointer',color:'rgba(60,60,67,0.6)',borderRadius:'50%',width:36,height:36,minWidth:36,display:'flex',alignItems:'center',justifyContent:'center'}}><X size={18}/></button>
          </div>
          <div style={{height:4,background:'rgba(120,120,128,0.12)',borderRadius:2,overflow:'hidden'}}>
            <div style={{height:'100%',background:'#007AFF',borderRadius:2,width:`${pct}%`,transition:'width 0.3s ease'}}/>
          </div>
          <div style={{display:'flex',gap:6,marginTop:10}}>
            {stepLabels.map((l,i)=>{
              const isVisited=i<=maxVisitedStep;
              const isActive=i===step;
              const willNeedKeys=i>1&&!keysComplete;
              const canClick=isVisited&&!isActive;
              return (
                <button
                  key={l}
                  onClick={()=>{
                    if(!canClick) return;
                    if(willNeedKeys){
                      // Jump anyway but show warning via existing banner
                    }
                    goToStep(i);
                  }}
                  disabled={!canClick}
                  title={canClick?(willNeedKeys?'API keys required for full functionality':'Jump to '+l):undefined}
                  style={{
                    flex:1,textAlign:'center',background:'none',border:'none',
                    cursor:canClick?'pointer':'default',padding:'0 0 4px 0',
                  }}
                >
                  <div style={{height:3,borderRadius:2,background:i<=step?'#007AFF':'rgba(120,120,128,0.12)',marginBottom:4,transition:'background 0.2s'}}/>
                  <div style={{
                    fontSize:9,
                    color:isActive?'#007AFF':i<step?'rgba(60,60,67,0.6)':'rgba(60,60,67,0.3)',
                    fontWeight:isActive?700:400,
                    textDecoration:canClick&&!isActive?'underline':'none',
                    textUnderlineOffset:2,
                  }}>{l}</div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Extraction loading screen */}
        {extracting&&(
          <div style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:20,padding:32,background:'transparent'}}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="https://cdn.dribbble.com/userupload/19917114/file/original-880f3ab68d9bcfe041db6649d5f8003b.gif" alt="Loading" style={{width:160,height:160,objectFit:'contain',borderRadius:8}}/>
            <div style={{textAlign:'center'}}>
              <div style={{fontSize:18,fontWeight:700,letterSpacing:'-0.02em',color:'#000',marginBottom:6}}>Gathering everything needed</div>
              <div style={{fontSize:13,color:'rgba(60,60,67,0.5)'}}>to optimize your search...</div>
            </div>
          </div>
        )}
        {/* Step content */}
        {!extracting&&<div style={{padding:'24px',flex:1}}>{stepContent()}</div>}

        {/* Keys warning banner — shown on all steps after step 1 if keys missing */}
        {step>1&&!keysComplete&&(
          <div style={{margin:'0 22px 14px',padding:'12px 16px',background:'rgba(255,149,0,0.08)',border:'0.5px solid rgba(255,149,0,0.3)',borderRadius:12,fontSize:12,color:'#B56000',display:'flex',alignItems:'center',gap:10,flexWrap:'wrap'}}>
            <AlertTriangle size={14} color="#007AFF"/>
            <span>API keys required to finish.</span>
            <button onClick={()=>goToStep(1)} style={{color:'#FF9500',background:'none',border:'none',cursor:'pointer',fontWeight:700,fontSize:12,textDecoration:'underline',padding:0}}>
              Go to API Keys step
            </button>
            <span>·</span>
            <button onClick={onOpenHowTo} style={{color:'#007AFF',background:'none',border:'none',cursor:'pointer',fontSize:12,textDecoration:'underline',padding:0,display:'flex',alignItems:'center',gap:3}}>
              <HelpCircle size={12}/>How to Use
            </button>
          </div>
        )}

        {/* Nav */}
        <div style={{padding:'14px 22px',borderTop:'0.5px solid rgba(60,60,67,0.18)',display:'flex',justifyContent:'space-between',position:'sticky',bottom:0,background:'rgba(255,255,255,0.97)',backdropFilter:'blur(20px)',WebkitBackdropFilter:'blur(20px)',borderRadius:'0 0 24px 24px'}}>
          <button onClick={()=>step>0?goToStep(step-1):onClose()} style={{display:'flex',alignItems:'center',gap:5,padding:'12px 20px',minHeight:44,background:'rgba(120,120,128,0.1)',border:'none',borderRadius:50,cursor:'pointer',fontWeight:600,fontSize:14,color:'#000'}}>
            <ChevronLeft size={14}/>{step===0?'Cancel':'Back'}
          </button>
          {!isLastStep
            ?<button onClick={()=>step===2?extractAndAdvance():goToStep(step+1)} disabled={extracting} style={{display:'flex',alignItems:'center',gap:5,padding:'12px 22px',minHeight:44,background:extracting?'#C7C7CC':'#007AFF',color:'#fff',border:'none',borderRadius:50,cursor:extracting?'not-allowed':'pointer',fontWeight:600,fontSize:14}}>
              Next<ChevronRight size={14}/>
            </button>
            :<div style={{display:'flex',flexDirection:'column',alignItems:'flex-end',gap:6}}>
              <button
                onClick={canFinish?finish:undefined}
                style={{display:'flex',alignItems:'center',gap:5,padding:'12px 22px',minHeight:44,background:canFinish?'#007AFF':'#C7C7CC',color:'#fff',border:'none',borderRadius:50,cursor:canFinish?'pointer':'not-allowed',fontWeight:600,fontSize:14}}
              >
                <CheckCircle size={15}/>Save &amp; Finish
              </button>
              {!canFinish&&<div style={{fontSize:11,color:'rgba(60,60,67,0.45)'}}>Complete API keys to enable</div>}
            </div>
          }
        </div>
      </div>
    </div>
  );
}

// ── Upload Card ────────────────────────────────────────────────────────────
function UploadCard({type,meta,onUpload}:{type:'resume'|'cover';meta:UploadMeta|null;onUpload:(f:File)=>Promise<void>;}) {
  const inputRef=useRef<HTMLInputElement>(null);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState('');
  const handle=async(e:React.ChangeEvent<HTMLInputElement>)=>{
    const file=e.target.files?.[0]; if(!file) return;
    setLoading(true); setError('');
    try{await onUpload(file);}
    catch(err:unknown){setError(err instanceof Error?err.message:'Upload failed');}
    finally{setLoading(false);if(inputRef.current)inputRef.current.value='';}
  };
  return (
    <div style={{background:'#fff',border:`1.5px dashed ${meta?'#34C759':'rgba(60,60,67,0.25)'}`,borderRadius:16,padding:'22px 18px',textAlign:'center',cursor:'pointer',transition:'all 0.2s',boxShadow:'0 1px 4px rgba(0,0,0,0.04)'}}
      onClick={meta?undefined:()=>inputRef.current?.click()}>
      <input ref={inputRef} type="file" accept=".html,.htm,.pdf,.docx" style={{display:'none'}} onChange={handle}/>
      <div style={{color:meta?'#34C759':'rgba(60,60,67,0.4)',marginBottom:7,display:'flex',justifyContent:'center'}}>
        {type==='resume'?<FileText size={24}/>:<Mail size={24}/>}
      </div>
      <div style={{fontWeight:700,fontSize:14,marginBottom:3,color:'#000',letterSpacing:'-0.01em'}}>{type==='resume'?'Upload Resume':'Upload Cover Letter'}</div>
      <div style={{fontSize:11,color:'rgba(60,60,67,0.5)',marginBottom:10}}>Text-only PDF · DOCX · HTML</div>
      {loading&&<div style={{fontSize:12,color:'#FF9500'}}>Parsing file...</div>}
      {error&&<div style={{fontSize:12,color:'#007AFF',marginTop:6}}>{error}</div>}
      {meta&&!loading&&(
        <div style={{display:'flex',alignItems:'center',gap:5,justifyContent:'center',background:'rgba(52,199,89,0.1)',borderRadius:10,padding:'7px 10px',marginTop:6}}>
          <CheckCircle size={12} color="#1A7A3C" fill="#1A7A3C"/>
          <div style={{textAlign:'left'}}>
            <div style={{fontSize:11,fontWeight:700,color:'#1A7A3C'}}>{meta.filename}</div>
            <div style={{fontSize:10,color:'rgba(26,122,60,0.7)'}}>Loaded {fmtDateTime(meta.uploadedAt)}</div>
          </div>
        </div>
      )}
      {!meta&&!loading&&(
        <div style={{display:'inline-flex',alignItems:'center',gap:5,background:'#007AFF',color:'#fff',borderRadius:50,padding:'6px 14px',fontSize:12,fontWeight:600}}>
          <Upload size={11}/>Choose File
        </div>
      )}
      {meta&&!loading&&(
        <button onClick={e=>{e.stopPropagation();inputRef.current?.click();}} style={{background:'none',border:'none',cursor:'pointer',fontSize:11,color:'rgba(60,60,67,0.5)',marginTop:8,display:'block',width:'100%',textAlign:'center'}}>
          Re-upload
        </button>
      )}
    </div>
  );
}

// ── How-To Drawer ──────────────────────────────────────────────────────────
function HowToDrawer({onClose}:{onClose:()=>void;}) {
  return (
    <>
      <div onClick={onClose} style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.35)',backdropFilter:'blur(6px)',WebkitBackdropFilter:'blur(6px)',zIndex:300}}/>
      <div style={{position:'fixed',top:52,right:0,bottom:0,width:400,maxWidth:'95vw',background:'rgba(255,255,255,0.96)',backdropFilter:'blur(20px)',WebkitBackdropFilter:'blur(20px)',zIndex:400,boxShadow:'-4px 0 40px rgba(0,0,0,0.12)',overflowY:'auto',animation:'slideInRight 0.25s cubic-bezier(0.32,0.72,0,1)'}}>
        <div style={{padding:'16px 20px 12px',borderBottom:'0.5px solid rgba(60,60,67,0.2)',display:'flex',justifyContent:'space-between',alignItems:'flex-start',position:'sticky',top:0,background:'rgba(255,255,255,0.96)',backdropFilter:'blur(20px)',WebkitBackdropFilter:'blur(20px)',zIndex:10}}>
          <div>
            <div style={{fontSize:11,letterSpacing:'0.06em',textTransform:'uppercase',color:'rgba(60,60,67,0.5)',fontWeight:600,marginBottom:4}}>Complete Guide</div>
            <h2 style={{fontSize:18,fontWeight:700,letterSpacing:'-0.02em',color:'#000'}}>How to Use</h2>
          </div>
          <button onClick={onClose} style={{background:'none',border:'none',cursor:'pointer',color:'rgba(60,60,67,0.5)',padding:4}}><X size={20}/></button>
        </div>
        <div style={{padding:'18px 22px',display:'flex',flexDirection:'column',gap:24}}>
          {[
            {num:'1',title:'First-Time Setup',color:'#007AFF',items:[
              ['Get Anthropic API Key','Go to console.anthropic.com/settings/keys → sign in → Create Key → copy it → paste in Settings tab. This is a separate account from Claude.ai.'],
              ['Get Serper API Key','Go to serper.dev → sign up free (2,500 searches/month) → Dashboard → API Key → paste in Settings tab.'],
              ['Guided Setup Wizard','On the Search tab, click "Launch Guided Experience" to walk through your profile setup step by step. The wizard auto-extracts data from your uploaded resume.'],
              ['Upload Templates','Search tab → Upload Resume + Cover Letter cards. Accepts HTML, DOCX, or text-based PDF. Scanned/image PDFs will not work for extraction.'],
            ]},
            {num:'2',title:'How Extraction Works',color:'#FF9500',items:[
              ['Resume Extraction','When you upload a resume (HTML, DOCX, or PDF), the app silently calls the Claude API to extract your name, contact info, job history, and skills. This costs approximately $0.01–0.03 per extraction.'],
              ['Instruction Auto-Update','Extracted data is used to personalize all three instruction sets (Job Search, Resume, Cover Letter) with your actual name, URLs, experience, and salary targets.'],
              ['Wizard Override','The Guided Setup Wizard lets you review and correct any extracted data before saving. Always review after extraction.'],
            ]},
            {num:'3',title:'Running a Job Search',color:'#000000',items:[
              ['Search Tab','Click "Run Job Search". Instructions are pre-loaded from your saved profile. Edit them only in Settings.'],
              ['Special Instructions','One-off override for this search session only — not saved permanently.'],
              ['Loading Screen','Shows estimated ready time (~5–6 min). Two-pass verified: Pass 1 searches all job boards, Pass 2 verifies each listing on the company\'s own site. Press Esc to cancel.'],
              ['Results','Board tab opens automatically with verified, triple-layer audited roles only.'],
            ]},
            {num:'4',title:'The Job Board',color:'#007AFF',items:[
              ['Filter & Sort','Filter by seniority level or Remote Only. Sort by Salary or Fit Rating.'],
              ['Expand Cards','Click any card for full details: role summary, why you fit, requirements, company info, gold & red flags.'],
              ['Excluded Jobs','Scroll to bottom of Board. Click "Add to Board" on any excluded role to manually promote it.'],
              ['Rating','Green 8–10 (near perfect), Amber 6–7 (strong with gap), Red 5–6 (solid fundamentals). Below 5 not shown.'],
            ]},
            {num:'5',title:'Generating Documents',color:'#1A7A3C',items:[
              ['Create Resume / Cover Letter','Button on each expanded job card. Opens the generation modal.'],
              ['Paste Full JD','For best ATS alignment, paste the complete job description text. The auto-filled version is a starting point only.'],
              ['Loading Screen','Full-screen overlay appears. Click "dismiss loading screen" to hide it — generation continues in background.'],
              ['"Generation in Progress"','While generating behind the scenes, a notice appears below the button on the card.'],
              ['Preview & Download','Preview opens the document in a new tab. Download saves as an HTML file named by role and company.'],
              ['Auto-Marked Applied','Generating any document marks the job as Applied in the tracker automatically.'],
            ]},
            {num:'6',title:'Applied Jobs Tracker',color:'#FF9500',items:[
              ['Status Timeline','Additive history: Applied → Interview → Offer → Rejected. Old statuses are never removed.'],
              ['Add Status','Click "+ Status" on any tracked job. Add an optional note per status entry.'],
              ['Duplicate Guard','"Already Applied" banner appears on Board cards for jobs in your tracker.'],
              ['Delete & Clear','Trash icon removes one job. "Clear All" resets the entire tracker.'],
            ]},
            {num:'7',title:'Settings',color:'#7A1AAA',items:[
              ['Edit Instructions','Three text areas: Job Search, Resume, Cover Letter. Each has its own Save and Reset to Default buttons.'],
              ['Reset Individual Set','Each instruction set has its own "Reset to Default" button with a confirmation modal.'],
              ['Save','Writes to localStorage immediately — no file or redeploy needed.'],
              ['Copy Instructions','Copies the full text to clipboard for manual repo updates if desired.'],
              ['API Keys','Paste keys here to override Vercel environment variables instantly without redeploying.'],
            ]},
            {num:'8',title:'Reset & Profile',color:'rgba(60,60,67,0.5)',items:[
              ['Reset All','The "Reset" button in the top nav clears ALL data: jobs, applied history, uploads, API keys, profile, and instructions. Requires confirmation.'],
              ['Re-run Wizard','Click "Launch Guided Experience" on the Search tab at any time to update your profile. All instructions update automatically.'],
              ['Wizard + Resume','If a resume is already uploaded when you open the wizard, it will note this and let you re-extract or continue with existing data.'],
            ]},
          ].map(section=>(
            <section key={section.num}>
              <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:10,borderLeft:`4px solid ${section.color}`,paddingLeft:12}}>
                <h3 style={{fontSize:16,fontWeight:400}}>{section.num} — {section.title}</h3>
              </div>
              <div style={{display:'flex',flexDirection:'column',gap:8,paddingLeft:4}}>
                {section.items.map(([t,d])=>(
                  <div key={t}>
                    <div style={{fontSize:12,fontWeight:700,color:'#000000',marginBottom:2}}>{t}</div>
                    <div style={{fontSize:12,color:'rgba(60,60,67,0.65)',lineHeight:1.65}}>{d}</div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </>
  );
}

// ── Generate Modal ─────────────────────────────────────────────────────────
function GenerateModal({job,type,onClose,instructions,apiKey,aiProvider}:{
  job:SavedJob;type:GenerateType;onClose:()=>void;instructions:string;apiKey:string;aiProvider:AIProvider;
}) {
  const [jd,setJd]=useState(job.roleSummary+'\n\nRequirements:\n'+(job.requirements?.join('\n')||''));
  const [loading,setLoading]=useState(false);
  const [dismissed,setDismissed]=useState(false);
  const [html,setHtml]=useState('');
  const [error,setError]=useState('');

  // Check if user has uploaded their own template
  const hasUploadedTemplate = type==='resume'
    ? !!getUploadedResumeMeta()
    : !!getUploadedCoverMeta();

  const generate=async()=>{
    setLoading(true);setDismissed(false);setError('');setHtml('');
    try{
      const res=await fetch('/ape/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          type,jobData:job,jobDescription:jd,instructions,apiKeyOverride:apiKey,aiProvider,
          uploadedTemplate:type==='resume'?getUploadedResume():getUploadedCover(),
        })});
      const data=await safeJson(res);
      if(!res.ok){setError((data.error as string)||'Generation failed.');return;}
      setHtml(data.html as string);
      markDocGenerated(job.id,type,{company:job.company,title:job.title,jobDescUrl:job.jobDescUrl,applyUrl:job.applyUrl});
    }catch(e:unknown){setError(e instanceof Error?e.message:'Unknown error');}
    finally{setLoading(false);}
  };

  const preview=()=>{const w=window.open('','_blank');if(w){w.document.write(html);w.document.close();}};
  const download=()=>{
    const blob=new Blob([html],{type:'text/html'});const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url;a.download=`${type==='resume'?'Resume':'CoverLetter'}_${job.company.replace(/[^a-zA-Z0-9]/g,'_')}_${job.title.replace(/[^a-zA-Z0-9]/g,'_').slice(0,30)}.html`;
    a.click();URL.revokeObjectURL(url);
  };

  return (
    <>
      {loading&&!dismissed&&<LoadingOverlay dismissOnly onDismiss={()=>setDismissed(true)} minutesEta={1}/>}
      <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.5)',zIndex:500,display:'flex',alignItems:'center',justifyContent:'center',padding:24}}>
        <div style={{background:'#fff',borderRadius:10,boxShadow:'0 8px 32px rgba(0,0,0,0.14)',width:'100%',maxWidth:660,maxHeight:'85vh',overflowY:'auto'}}>
          <div style={{padding:'20px 22px 14px',borderBottom:'0.5px solid rgba(60,60,67,0.2)',display:'flex',alignItems:'center',justifyContent:'space-between',position:'sticky',top:0,background:'#fff'}}>
            <div>
              <div style={{fontSize:10,letterSpacing:'0.12em',textTransform:'uppercase',color:'#007AFF',fontWeight:700,marginBottom:4}}>{type==='resume'?'Create Resume':'Create Cover Letter'}</div>
              <h2 style={{fontSize:17}}>{job.company} — {job.title}</h2>
            </div>
            <button onClick={onClose} style={{background:'none',border:'none',cursor:'pointer',color:'rgba(60,60,67,0.5)'}}><X size={20}/></button>
          </div>
          <div style={{padding:22}}>
            {loading&&dismissed&&<div style={{display:'flex',alignItems:'center',gap:8,background:'rgba(255,204,0,0.12)',borderRadius:10,padding:'10px 14px',marginBottom:14}}><Clock size={14} color="#FF9500"/><span style={{fontSize:13,color:'#7A5500',fontWeight:600}}>Generation in progress...</span></div>}
            {!hasUploadedTemplate&&(
              <div style={{background:'rgba(255,59,48,0.04)',border:'0.5px solid rgba(255,59,48,0.2)',borderRadius:10,padding:'12px 14px',marginBottom:14,display:'flex',alignItems:'flex-start',gap:10}}>
                <AlertTriangle size={15} color="#007AFF" style={{flexShrink:0,marginTop:2}}/>
                <div>
                  <div style={{fontSize:13,fontWeight:700,color:'#D70015',marginBottom:3}}>No {type==='resume'?'resume':'cover letter'} template uploaded</div>
                  <div style={{fontSize:12,color:'#D70015',lineHeight:1.6}}>
                    Upload your {type==='resume'?'resume':'cover letter'} template on the Search tab or in the Setup Wizard for best results. Generation will use the default blank template until you upload your own.
                  </div>
                </div>
              </div>
            )}
            <div style={{fontSize:10,fontWeight:700,letterSpacing:'0.15em',textTransform:'uppercase',color:'rgba(60,60,67,0.6)',marginBottom:6}}>Job Description</div>
            <textarea value={jd} onChange={e=>setJd(e.target.value)} rows={9} disabled={loading}
              style={{width:'100%',padding:'9px 12px',border:'0.5px solid rgba(60,60,67,0.2)',borderRadius:10,fontSize:13,resize:'vertical',outline:'none',marginBottom:14}}
              placeholder="Paste full job description for best ATS alignment..."/>
            {error&&<div style={{background:'rgba(0,122,255,0.12)',color:'#D70015',padding:'10px 14px',borderRadius:10,marginBottom:14,fontSize:13,display:'flex',gap:8,alignItems:'center'}}><AlertTriangle size={15}/>{error}</div>}
            {html&&!loading&&<div style={{background:'rgba(52,199,89,0.12)',color:'#1a5c38',padding:'10px 14px',borderRadius:10,marginBottom:14,fontSize:13,display:'flex',gap:8,alignItems:'center'}}><CheckCircle size={15} fill="#1a5c38" color="#1a5c38"/>Document generated. Preview or download below.</div>}
          </div>
          <div style={{padding:'14px 22px',borderTop:'0.5px solid rgba(60,60,67,0.2)',display:'flex',gap:8,justifyContent:'flex-end',flexWrap:'wrap',position:'sticky',bottom:0,background:'#fff'}}>
            {html&&<>
              <button onClick={preview} style={{display:'flex',alignItems:'center',gap:6,padding:'8px 14px',border:'0.5px solid rgba(60,60,67,0.2)',borderRadius:10,background:'transparent',cursor:'pointer',fontSize:12,fontWeight:600}}><ExternalLink size={13}/>Preview</button>
              <button onClick={download} style={{display:'flex',alignItems:'center',gap:6,padding:'8px 14px',background:'#007AFF',color:'#fff',border:'none',borderRadius:10,cursor:'pointer',fontSize:12,fontWeight:600}}><Upload size={13}/>Download</button>
              <button onClick={generate} disabled={loading} style={{display:'flex',alignItems:'center',gap:6,padding:'8px 12px',border:'0.5px solid rgba(60,60,67,0.2)',borderRadius:10,background:'transparent',cursor:'pointer',fontSize:12,fontWeight:600,color:'rgba(60,60,67,0.6)'}}><RotateCcw size={12}/>Regenerate</button>
            </>}
            {!html&&<button onClick={generate} disabled={loading} style={{display:'flex',alignItems:'center',gap:6,padding:'10px 20px',background:'#000000',color:'#fff',border:'none',borderRadius:10,cursor:loading?'not-allowed':'pointer',fontSize:13,fontWeight:600,opacity:loading?0.6:1}}><Sparkles size={14}/>{loading?'Generating...':`Generate ${type==='resume'?'Resume':'Cover Letter'}`}</button>}
            <button onClick={onClose} style={{display:'flex',alignItems:'center',gap:6,padding:'8px 14px',border:'0.5px solid rgba(60,60,67,0.2)',borderRadius:10,background:'transparent',cursor:'pointer',fontSize:12,fontWeight:600}}><X size={13}/>Close</button>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Small Modals ───────────────────────────────────────────────────────────
function SpecialModal({value,onChange,onClose}:{value:string;onChange:(v:string)=>void;onClose:()=>void;}) {
  const [local,setLocal]=useState(value);
  return (
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.5)',zIndex:600,display:'flex',alignItems:'center',justifyContent:'center',padding:24}}>
      <div style={{background:'#fff',borderRadius:10,width:'100%',maxWidth:560,boxShadow:'0 8px 32px rgba(0,0,0,0.14)'}}>
        <div style={{padding:'18px 22px 14px',borderBottom:'0.5px solid rgba(60,60,67,0.2)',display:'flex',justifyContent:'space-between'}}>
          <div><div style={{fontSize:10,letterSpacing:'0.15em',textTransform:'uppercase',color:'#007AFF',fontWeight:700,marginBottom:4}}>One-Off Override</div><h2 style={{fontSize:19}}>Special Instructions</h2></div>
          <button onClick={onClose} style={{background:'none',border:'none',cursor:'pointer',color:'rgba(60,60,67,0.5)'}}><X size={19}/></button>
        </div>
        <div style={{padding:22}}>
          <p style={{fontSize:13,color:'rgba(60,60,67,0.65)',marginBottom:12,lineHeight:1.6}}>Appended to your search instructions for this run only. Not saved.</p>
          <textarea value={local} onChange={e=>setLocal(e.target.value)} rows={6}
            style={{width:'100%',padding:'9px 12px',border:'0.5px solid rgba(60,60,67,0.2)',borderRadius:10,fontSize:13,resize:'vertical',outline:'none'}}
            placeholder="e.g. Focus only on fintech companies this time..."/>
        </div>
        <div style={{padding:'14px 22px',borderTop:'0.5px solid rgba(60,60,67,0.2)',display:'flex',gap:8,justifyContent:'flex-end'}}>
          <button onClick={()=>{onChange(local);onClose();}} style={{padding:'9px 16px',background:'#000000',color:'#fff',border:'none',borderRadius:10,cursor:'pointer',fontWeight:600,fontSize:13}}>Apply for this search</button>
          <button onClick={()=>{onChange('');onClose();}} style={{padding:'9px 16px',border:'0.5px solid rgba(60,60,67,0.2)',borderRadius:10,background:'transparent',cursor:'pointer',fontWeight:600,fontSize:13}}>Clear & Close</button>
        </div>
      </div>
    </div>
  );
}

function AddStatusModal({jobId,onClose}:{jobId:string;onClose:()=>void;}) {
  const [status,setStatus]=useState<StatusEntry['status']>('interview');
  const [note,setNote]=useState('');
  const statuses:StatusEntry['status'][]=['applied','interview','offer','rejected'];
  return (
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.5)',zIndex:600,display:'flex',alignItems:'center',justifyContent:'center',padding:24}}>
      <div style={{background:'#fff',borderRadius:10,width:'100%',maxWidth:420,boxShadow:'0 8px 32px rgba(0,0,0,0.14)'}}>
        <div style={{padding:'18px 22px 14px',borderBottom:'0.5px solid rgba(60,60,67,0.2)',display:'flex',justifyContent:'space-between'}}>
          <h2 style={{fontSize:19}}>Add Status Update</h2>
          <button onClick={onClose} style={{background:'none',border:'none',cursor:'pointer',color:'rgba(60,60,67,0.5)'}}><X size={19}/></button>
        </div>
        <div style={{padding:22}}>
          <div style={{fontSize:10,fontWeight:700,letterSpacing:'0.15em',textTransform:'uppercase',color:'rgba(60,60,67,0.6)',marginBottom:10}}>Status</div>
          <div style={{display:'flex',gap:8,marginBottom:18,flexWrap:'wrap'}}>
            {statuses.map(s=>(
              <button key={s} onClick={()=>setStatus(s)} style={{padding:'6px 14px',borderRadius:10,border:`2px solid ${status===s?'#000000':'rgba(60,60,67,0.2)'}`,background:status===s?'#000000':'transparent',color:status===s?'#fff':'rgba(60,60,67,0.6)',fontWeight:700,fontSize:12,textTransform:'uppercase',letterSpacing:'0.06em',cursor:'pointer'}}>{s}</button>
            ))}
          </div>
          <div style={{fontSize:10,fontWeight:700,letterSpacing:'0.15em',textTransform:'uppercase',color:'rgba(60,60,67,0.6)',marginBottom:6}}>Note (optional)</div>
          <input type="text" value={note} onChange={e=>setNote(e.target.value)} placeholder="e.g. Phone screen Friday..."
            style={{width:'100%',padding:'9px 12px',border:'0.5px solid rgba(60,60,67,0.2)',borderRadius:10,fontSize:13,outline:'none'}}/>
        </div>
        <div style={{padding:'14px 22px',borderTop:'0.5px solid rgba(60,60,67,0.2)',display:'flex',gap:8,justifyContent:'flex-end'}}>
          <button onClick={()=>{addStatusToJob(jobId,status,note||undefined);onClose();}} style={{padding:'9px 16px',background:'#000000',color:'#fff',border:'none',borderRadius:10,cursor:'pointer',fontWeight:600,fontSize:13}}>Add Status</button>
          <button onClick={onClose} style={{padding:'9px 16px',border:'0.5px solid rgba(60,60,67,0.2)',borderRadius:10,background:'transparent',cursor:'pointer',fontWeight:600,fontSize:13}}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function MobileFAB({instructions,onClose}:{instructions:string;onClose:()=>void;}) {
  return (
    <>
      <div onClick={onClose} style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.4)',zIndex:800}}/>
      <div style={{position:'fixed',bottom:0,left:0,right:0,zIndex:900,height:'75vh',background:'#fff',borderRadius:'16px 16px 0 0',boxShadow:'0 -8px 32px rgba(0,0,0,0.2)',display:'flex',flexDirection:'column',animation:'slideUpSheet 0.3s ease'}}>
        <div style={{padding:'14px 18px 12px',borderBottom:'0.5px solid rgba(60,60,67,0.2)',display:'flex',justifyContent:'space-between',alignItems:'center',position:'sticky',top:0,background:'#fff'}}>
          <div style={{fontSize:11,fontWeight:700,letterSpacing:'0.15em',textTransform:'uppercase',color:'#007AFF'}}>Search Instructions</div>
          <button onClick={onClose} style={{background:'none',border:'none',cursor:'pointer',color:'rgba(60,60,67,0.5)'}}><X size={20}/></button>
        </div>
        <div style={{padding:'14px 18px',flex:1,overflowY:'auto',overflowX:'hidden'}}>
          <pre style={{fontSize:11,color:'rgba(60,60,67,0.85)',lineHeight:1.7,whiteSpace:'pre-wrap',wordBreak:'break-word',fontFamily:'monospace'}}>{instructions}</pre>
        </div>
      </div>
    </>
  );
}

// ── Job Card ───────────────────────────────────────────────────────────────

// ── Analyze JD Input ──────────────────────────────────────────────────────
function AnalyzeJDInput({excl,onContinue,onClose}:{
  excl:{company:string;title:string;jobDescUrl?:string;applyUrl?:string};
  onContinue:(jdText:string)=>void;
  onClose:()=>void;
}) {
  const [mode,setMode]=useState<'none'|'file'|'text'>('none');
  const [jdText,setJdText]=useState('');
  const fileRef=useRef<HTMLInputElement>(null);
  const [fileName,setFileName]=useState('');
  const jdUrl=excl.jobDescUrl&&excl.jobDescUrl!=='#'?excl.jobDescUrl:excl.applyUrl&&excl.applyUrl!=='#'?excl.applyUrl:null;

  const handleFile=async(e:React.ChangeEvent<HTMLInputElement>)=>{
    const f=e.target.files?.[0]; if(!f) return;
    try{const text=await parseFile(f);setJdText(text);setFileName(f.name);}
    catch{setFileName('Error reading file');}
  };

  return (
    <>
      <div style={{padding:22}}>
        <p style={{fontSize:13,color:'rgba(60,60,67,0.65)',lineHeight:1.7,marginBottom:16}}>
          Provide the job description below for a more accurate analysis — or just continue and we'll do our best with available information.
        </p>
        <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:10,flexWrap:'nowrap'}}>
          <div style={{fontSize:10,fontWeight:700,letterSpacing:'0.15em',textTransform:'uppercase',color:'rgba(60,60,67,0.6)',whiteSpace:'nowrap'}}>Optional: Provide Job Description</div>
          {jdUrl&&(
            <a href={jdUrl} target="_blank" rel="noreferrer" style={{display:'inline-flex',alignItems:'center',gap:3,fontSize:10,color:'#007AFF',textDecoration:'none',fontWeight:600,whiteSpace:'nowrap'}}>
              · View JD ↗
            </a>
          )}
        </div>

        <div style={{display:'flex',gap:10,marginBottom:16,flexWrap:'wrap'}}>
          {[['none','Skip — continue anyway'],['file','Upload HTML file'],['text','Paste JD text']].map(([val,label])=>(
            <button key={val} onClick={()=>setMode(val as 'none'|'file'|'text')} style={{padding:'8px 14px',borderRadius:10,border:`2px solid ${mode===val?'#000000':'rgba(60,60,67,0.2)'}`,background:mode===val?'#000000':'transparent',color:mode===val?'#fff':'rgba(60,60,67,0.6)',fontWeight:600,fontSize:12,cursor:'pointer'}}>
              {label}
            </button>
          ))}
        </div>

        {mode==='file'&&(
          <div>
            <input ref={fileRef} type="file" accept=".html,.htm,.txt" style={{display:'none'}} onChange={handleFile}/>
            <div onClick={()=>fileRef.current?.click()} style={{border:'2px dashed rgba(60,60,67,0.2)',borderRadius:14,padding:'16px 20px',textAlign:'center',cursor:'pointer',marginBottom:8}}>
              <Upload size={20} color="rgba(60,60,67,0.6)" style={{marginBottom:6}}/>
              <div style={{fontSize:13,fontWeight:600}}>{fileName||'Choose HTML or TXT file'}</div>
            </div>
          </div>
        )}
        {mode==='text'&&(
          <textarea value={jdText} onChange={e=>setJdText(e.target.value)} rows={7} placeholder="Paste the full job description text here..."
            style={{width:'100%',padding:'9px 12px',border:'0.5px solid rgba(60,60,67,0.2)',borderRadius:10,fontSize:13,resize:'vertical',outline:'none'}}/>
        )}
        <p style={{fontSize:12,color:'rgba(60,60,67,0.45)',marginTop:10,letterSpacing:'-0.01em'}}>Neither is required — click Continue to add the card with available information.</p>
      </div>
      <div style={{padding:'14px 22px',borderTop:'0.5px solid rgba(60,60,67,0.2)',display:'flex',gap:10,justifyContent:'flex-end',position:'sticky',bottom:0,background:'#fff'}}>
        <button onClick={()=>onContinue(jdText)} style={{padding:'9px 18px',background:'#000000',color:'#fff',border:'none',borderRadius:10,cursor:'pointer',fontWeight:700,fontSize:13}}>Continue</button>
        <button onClick={onClose} style={{padding:'9px 16px',border:'0.5px solid rgba(60,60,67,0.2)',borderRadius:10,background:'transparent',cursor:'pointer',fontWeight:600,fontSize:13}}>Cancel</button>
      </div>
    </>
  );
}

function JobCard({job,applied,onGenerate,generatingType,onReturnToExcluded}:{
  job:SavedJob;applied:boolean;
  onGenerate:(job:SavedJob,type:GenerateType)=>void;
  generatingType?:GenerateType|null;
  onReturnToExcluded?:(job:SavedJob)=>void;
}) {
  const [open,setOpen]=useState(false);
  return (
    <div style={{background:'#fff',border:`0.5px solid ${applied?'rgba(255,149,0,0.4)':'rgba(60,60,67,0.12)'}`,borderRadius:16,overflow:'hidden',transition:'box-shadow 0.2s,transform 0.1s',boxShadow:'0 1px 4px rgba(0,0,0,0.06)'}}
      onMouseEnter={e=>{(e.currentTarget as HTMLDivElement).style.boxShadow='0 6px 20px rgba(0,0,0,0.1)';(e.currentTarget as HTMLDivElement).style.transform='translateY(-1px)';}}
      onMouseLeave={e=>{(e.currentTarget as HTMLDivElement).style.boxShadow='0 1px 4px rgba(0,0,0,0.06)';(e.currentTarget as HTMLDivElement).style.transform='';}}>
      {applied&&<div style={{background:'rgba(255,204,0,0.12)',padding:'4px 14px',fontSize:11,fontWeight:700,color:'#FF9500',letterSpacing:'0.06em',borderBottom:'0.5px solid #e8d89a',display:'flex',alignItems:'center',gap:6}}><CheckCircle size={11} fill="#FF9500" color="#FF9500"/>ALREADY APPLIED</div>}
      <div style={{padding:'16px 18px 12px',cursor:'pointer',display:'flex',justifyContent:'space-between',gap:12}} onClick={()=>setOpen(!open)}>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:11,letterSpacing:'0.1em',textTransform:'uppercase',fontWeight:700,color:'#007AFF',marginBottom:3,display:'flex',alignItems:'center',gap:5}}><Building2 size={11}/>{job.company}</div>
          <div style={{fontSize:17,fontWeight:700,letterSpacing:'-0.02em',color:'#000',lineHeight:1.2,marginBottom:8}}>{job.title}</div>
          <div style={{display:'flex',flexWrap:'wrap',gap:5}}>
            {job.isRemote&&<span style={{background:'rgba(52,199,89,0.12)',color:'#1A7A3C',fontSize:10,fontWeight:700,letterSpacing:'0.06em',textTransform:'uppercase',padding:'2px 7px',borderRadius:10,display:'flex',alignItems:'center',gap:3}}><MapPin size={9}/>Remote</span>}
            {job.isHybrid&&<span style={{background:'rgba(255,204,0,0.12)',color:'#FF9500',fontSize:10,fontWeight:700,letterSpacing:'0.06em',padding:'2px 7px',borderRadius:10,display:'flex',alignItems:'center',gap:3}}><MapPin size={9}/>Hybrid{(job as SavedJob&{location?:string}).location&&(job as SavedJob&{location?:string}).location!=='N/A'&&(job as SavedJob&{location?:string}).location!==''?` · ${(job as SavedJob&{location?:string}).location}`:''}</span>}
            {(job as SavedJob&{isOnsite?:boolean;location?:string}).isOnsite&&<span style={{background:'rgba(88,86,214,0.1)',color:'#5856D6',fontSize:10,fontWeight:700,letterSpacing:'0.06em',padding:'2px 7px',borderRadius:10,display:'flex',alignItems:'center',gap:3}}><Building2 size={9}/>Office{(job as SavedJob&{location?:string}).location&&(job as SavedJob&{location?:string}).location!=='N/A'&&(job as SavedJob&{location?:string}).location!==''?` · ${(job as SavedJob&{location?:string}).location}`:''}</span>}
            {(job.industry||[]).map(ind=><span key={ind} style={{background:'rgba(0,122,255,0.1)',color:'#005BD3',fontSize:10,fontWeight:600,padding:'3px 8px',borderRadius:50}}>{ind}</span>)}
          </div>
          <div style={{marginTop:9,fontSize:11,color:'#007AFF',display:'flex',alignItems:'center',gap:4,fontWeight:500}}>
            {open?<ChevronUp size={11}/>:<ChevronDown size={11}/>}{open?'Hide details':'View full details'}
          </div>
        </div>
        <div style={{display:'flex',flexDirection:'column',alignItems:'flex-end',gap:7,flexShrink:0}}>
          <div style={{width:48,height:48,borderRadius:'50%',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',fontWeight:700,
            ...(job.rating>=8?{background:'rgba(52,199,89,0.12)',color:'#1A7A3C',border:'0.5px solid rgba(52,199,89,0.4)'}:job.rating>=6?{background:'rgba(255,149,0,0.1)',color:'#B56000',border:'0.5px solid rgba(255,149,0,0.35)'}:{background:'rgba(255,59,48,0.1)',color:'#D70015',border:'0.5px solid rgba(255,59,48,0.3)'})}}>
            <Star size={9} fill="currentColor"/><span style={{fontSize:14,lineHeight:1}}>{job.rating}</span>
          </div>
          <div style={{textAlign:'right'}}>
            <div style={{fontSize:13,fontWeight:700,display:'flex',alignItems:'center',gap:3,justifyContent:'flex-end',letterSpacing:'-0.01em',color:'#000'}}><DollarSign size={11}/>{job.salaryDisplay}</div>
            <div style={{fontSize:10,color:'rgba(60,60,67,0.5)'}}>{job.salaryNote}</div>
          </div>
        </div>
      </div>
      {open&&(
        <div style={{borderTop:'0.5px solid rgba(60,60,67,0.12)',padding:'16px 18px',background:'#F2F2F7'}}>
          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(240px,1fr))',gap:16,marginBottom:16}}>
            <div><div style={{fontSize:11,fontWeight:600,letterSpacing:'0.04em',textTransform:'uppercase',color:'rgba(60,60,67,0.5)',marginBottom:5}}>Role Summary</div><p style={{fontSize:13,color:'rgba(60,60,67,0.85)',lineHeight:1.65}}>{job.roleSummary}</p></div>
            <div><div style={{fontSize:11,fontWeight:600,letterSpacing:'0.04em',textTransform:'uppercase',color:'rgba(60,60,67,0.5)',marginBottom:5}}>Why You Fit ({job.rating}/10)</div><ul style={{paddingLeft:15,fontSize:13,color:'rgba(60,60,67,0.85)',lineHeight:1.65}}>{(job.whyYouFit||[]).map((b,i)=><li key={i} style={{marginBottom:2}}>{b}</li>)}</ul></div>
            <div><div style={{fontSize:11,fontWeight:600,letterSpacing:'0.04em',textTransform:'uppercase',color:'rgba(60,60,67,0.5)',marginBottom:5}}>Requirements</div><ul style={{paddingLeft:15,fontSize:13,color:'rgba(60,60,67,0.85)',lineHeight:1.65}}>{(job.requirements||[]).map((r,i)=><li key={i} style={{marginBottom:2}}>{r}</li>)}</ul></div>
            <div>
              <div style={{fontSize:11,fontWeight:600,letterSpacing:'0.04em',textTransform:'uppercase',color:'rgba(60,60,67,0.5)',marginBottom:5}}>Company Info</div>
              <p style={{fontSize:13,color:'rgba(60,60,67,0.85)',lineHeight:1.65,marginBottom:8}}>{job.companyInfo}</p>
              {job.goldFlags?.length>0&&<div style={{marginBottom:6}}><div style={{fontSize:10,fontWeight:700,letterSpacing:'0.1em',textTransform:'uppercase',color:'#1A7A3C',marginBottom:3,display:'flex',alignItems:'center',gap:4}}><Flag size={10} fill="#1A7A3C"/>Gold Flags</div><ul style={{paddingLeft:15,fontSize:12,color:'#1A7A3C',lineHeight:1.6}}>{job.goldFlags.map((f,i)=><li key={i}>{f}</li>)}</ul></div>}
              {job.redFlags?.length>0&&<div><div style={{fontSize:10,fontWeight:700,letterSpacing:'0.1em',textTransform:'uppercase',color:'#007AFF',marginBottom:3,display:'flex',alignItems:'center',gap:4}}><Flag size={10} fill="#007AFF"/>Red Flags</div><ul style={{paddingLeft:15,fontSize:12,color:'#D70015',lineHeight:1.6}}>{job.redFlags.map((f,i)=><li key={i}>{f}</li>)}</ul></div>}
            </div>
          </div>
          <div style={{borderTop:'0.5px solid rgba(60,60,67,0.12)',paddingTop:12,display:'flex',gap:8,flexWrap:'wrap',alignItems:'center'}}>
            <a href={job.applyUrl} target="_blank" rel="noreferrer" style={{display:'flex',alignItems:'center',gap:5,padding:'7px 14px',background:'#007AFF',color:'#fff',borderRadius:50,fontSize:12,fontWeight:600,textDecoration:'none'}}><ExternalLink size={12}/>Apply</a>
            <a href={job.careersUrl} target="_blank" rel="noreferrer" style={{display:'flex',alignItems:'center',gap:5,padding:'7px 14px',background:'rgba(120,120,128,0.1)',border:'none',borderRadius:50,fontSize:12,fontWeight:600,textDecoration:'none',color:'#000'}}><Briefcase size={12}/>Careers</a>
            <a href={job.aboutUrl} target="_blank" rel="noreferrer" style={{display:'flex',alignItems:'center',gap:5,padding:'7px 14px',background:'rgba(120,120,128,0.1)',border:'none',borderRadius:50,fontSize:12,fontWeight:600,textDecoration:'none',color:'#000'}}><ExternalLink size={12}/>About</a>
            <div style={{marginLeft:'auto',display:'flex',gap:8,flexWrap:'wrap'}}>
              <div style={{display:'flex',flexDirection:'column',alignItems:'flex-end',gap:3}}>
                <button onClick={()=>onGenerate(job,'resume')} disabled={generatingType==='resume'} style={{display:'flex',alignItems:'center',gap:5,padding:'7px 14px',background:'rgba(0,122,255,0.1)',color:'#005BD3',border:'none',borderRadius:50,fontSize:12,fontWeight:600,cursor:'pointer'}}>
                  <FileText size={13} fill="#007AFF"/>{generatingType==='resume'?'Generating...':'Create Resume'}
                </button>
                {generatingType==='resume'&&<span style={{fontSize:10,color:'#FF9500',fontWeight:500}}>generating...</span>}
              </div>
              <div style={{display:'flex',flexDirection:'column',alignItems:'flex-end',gap:3}}>
                <button onClick={()=>onGenerate(job,'coverLetter')} disabled={generatingType==='coverLetter'} style={{display:'flex',alignItems:'center',gap:5,padding:'7px 14px',background:'rgba(175,82,222,0.1)',color:'#7A1AAA',border:'none',borderRadius:50,fontSize:12,fontWeight:600,cursor:'pointer'}}>
                  <Mail size={13} fill="#7A1AAA"/>{generatingType==='coverLetter'?'Generating...':'Create Cover Letter'}
                </button>
                {generatingType==='coverLetter'&&<span style={{fontSize:10,color:'#FF9500',fontWeight:500}}>generating...</span>}
              </div>
            </div>
          </div>
          <div style={{marginTop:9,paddingTop:9,borderTop:'0.5px solid rgba(60,60,67,0.12)',fontSize:11,color:'rgba(60,60,67,0.5)',display:'flex',alignItems:'center',gap:6,flexWrap:'wrap'}}>
            <CheckCircle size={11}/>{job.auditLabel}<span>·</span><Clock size={11}/>{job.postedDate}<span>·</span>
            <a href={job.jobDescUrl} target="_blank" rel="noreferrer" style={{color:'#007AFF',textDecoration:'none',display:'flex',alignItems:'center',gap:3,fontWeight:500}}><ExternalLink size={11}/>View JD</a>
            {(job as SavedJob&{manuallyAdded?:boolean}).manuallyAdded&&onReturnToExcluded&&(
              <><span>·</span><button onClick={(e)=>{e.stopPropagation();onReturnToExcluded(job);}} style={{background:'none',border:'none',cursor:'pointer',color:'rgba(60,60,67,0.5)',fontSize:11,padding:0,display:'flex',alignItems:'center',gap:3}}>Return to Excluded</button></>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Save/Import Modal ──────────────────────────────────────────────────────
function SaveImportModal({onClose,onImportComplete}:{onClose:()=>void;onImportComplete:()=>void;}) {
  const [phase,setPhase]=useState<'menu'|'importing'|'invalid'|'confirmOverwrite'>('menu');
  const [pendingData,setPendingData]=useState<unknown>(null);
  const fileRef=useRef<HTMLInputElement>(null);

  const handleExport=()=>{
    const data=exportAppData();
    const json=JSON.stringify(data,null,2);
    const blob=new Blob([json],{type:'application/json'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    const ts=new Date().toISOString().slice(0,10);
    a.href=url;a.download=`ape-x-job-hunt-${ts}.json`;a.click();
    URL.revokeObjectURL(url);
  };

  const handleFileSelect=async(e:React.ChangeEvent<HTMLInputElement>)=>{
    const f=e.target.files?.[0]; if(!f) return;
    setPhase('importing');
    try{
      await new Promise(r=>setTimeout(r,1200)); // show loading screen
      const text=await f.text();
      const parsed=JSON.parse(text);
      if(!validateImport(parsed)){setPhase('invalid');return;}
      setPendingData(parsed);
      setPhase('confirmOverwrite');
    }catch{setPhase('invalid');}
    if(fileRef.current) fileRef.current.value='';
  };

  const doImport=()=>{
    if(!pendingData) return;
    importAppData(pendingData as Parameters<typeof importAppData>[0]);
    onImportComplete();
    onClose();
  };

  if(phase==='importing') return (
    <div style={{position:'fixed',inset:0,background:'#000',zIndex:1100,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:24}}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="https://cdn.dribbble.com/userupload/19917114/file/original-880f3ab68d9bcfe041db6649d5f8003b.gif" alt="Loading" style={{width:200,height:200,objectFit:'contain',borderRadius:8}}/>
      <div style={{fontSize:20,color:'rgba(255,255,255,0.9)'}}>Applying your file...</div>
      <div style={{fontSize:13,color:'rgba(255,255,255,0.5)'}}>Validating import data</div>
    </div>
  );

  if(phase==='invalid') return (
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.6)',zIndex:1100,display:'flex',alignItems:'center',justifyContent:'center',padding:24}}>
      <div style={{background:'#fff',borderRadius:10,maxWidth:380,width:'100%',padding:28,textAlign:'center',boxShadow:'0 8px 32px rgba(0,0,0,0.2)'}}>
        <AlertTriangle size={36} color="#007AFF" style={{marginBottom:14}}/>
        <h2 style={{fontSize:22,marginBottom:10}}>File is Not Valid</h2>
        <p style={{fontSize:13,color:'rgba(60,60,67,0.65)',lineHeight:1.7,marginBottom:20}}>This file doesn't appear to be a valid Ape X Job Hunt export. No settings were changed.</p>
        <button onClick={()=>setPhase('menu')} style={{padding:'10px 24px',background:'#000000',color:'#fff',border:'none',borderRadius:10,cursor:'pointer',fontWeight:700,fontSize:14}}>Try Again</button>
        <button onClick={onClose} style={{marginLeft:10,padding:'10px 20px',border:'0.5px solid rgba(60,60,67,0.2)',borderRadius:10,background:'transparent',cursor:'pointer',fontWeight:600,fontSize:14}}>Cancel</button>
      </div>
    </div>
  );

  if(phase==='confirmOverwrite') return (
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.6)',zIndex:1100,display:'flex',alignItems:'center',justifyContent:'center',padding:24}}>
      <div style={{background:'#fff',borderRadius:10,maxWidth:440,width:'100%',padding:28,textAlign:'center',boxShadow:'0 8px 32px rgba(0,0,0,0.2)'}}>
        <AlertTriangle size={36} color="#007AFF" style={{marginBottom:14}}/>
        <h2 style={{fontSize:22,marginBottom:10}}>Import Will Overwrite Everything</h2>
        <p style={{fontSize:13,color:'rgba(60,60,67,0.65)',lineHeight:1.7,marginBottom:20}}>
          All current jobs, settings, instructions, profile data, and uploaded documents will be replaced with the imported file. This cannot be undone.
        </p>
        <div style={{display:'flex',gap:10,justifyContent:'center'}}>
          <button onClick={doImport} style={{padding:'10px 22px',background:'#007AFF',color:'#fff',border:'none',borderRadius:10,cursor:'pointer',fontWeight:700,fontSize:13}}>Continue — Import</button>
          <button onClick={onClose} style={{padding:'10px 20px',border:'0.5px solid rgba(60,60,67,0.2)',borderRadius:10,background:'transparent',cursor:'pointer',fontWeight:600,fontSize:13}}>Cancel</button>
        </div>
      </div>
    </div>
  );

  // Menu state
  return (
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.5)',zIndex:1000,display:'flex',alignItems:'center',justifyContent:'center',padding:24}}>
      <div style={{background:'#fff',borderRadius:10,width:'100%',maxWidth:520,boxShadow:'0 8px 32px rgba(0,0,0,0.14)'}}>
        <div style={{padding:'20px 24px 14px',borderBottom:'0.5px solid rgba(60,60,67,0.2)',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <div>
            <div style={{fontSize:10,letterSpacing:'0.15em',textTransform:'uppercase',color:'#007AFF',fontWeight:700,marginBottom:4}}>Portable Data</div>
            <h2 style={{fontSize:18,fontWeight:700,letterSpacing:'-0.02em',color:'#000'}}>Save or Import Job Board</h2>
          </div>
          <button onClick={onClose} style={{background:'none',border:'none',cursor:'pointer',color:'rgba(60,60,67,0.5)'}}><X size={20}/></button>
        </div>
        <div style={{padding:24,display:'grid',gap:14}}>
          {/* Save option */}
          <div style={{border:'0.5px solid rgba(60,60,67,0.2)',borderRadius:14,padding:'18px 20px'}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:14}}>
              <div style={{flex:1}}>
                <div style={{fontWeight:700,fontSize:14,marginBottom:4,display:'flex',alignItems:'center',gap:7}}><FileText size={15}/>Save Current Job Board</div>
                <p style={{fontSize:12,color:'rgba(60,60,67,0.65)',lineHeight:1.65}}>
                  Exports everything — jobs, applied history, instructions, profile, search history, and uploaded documents — to a portable <code style={{background:'#F2F2F7',padding:'1px 5px',borderRadius:3}}>json</code> file. API keys are included so the session is fully portable. Store this file securely.
                </p>
              </div>
              <button onClick={handleExport} style={{flexShrink:0,padding:'9px 16px',background:'#000000',color:'#fff',border:'none',borderRadius:10,cursor:'pointer',fontWeight:700,fontSize:13,display:'flex',alignItems:'center',gap:6}}>
                <Upload size={14}/>Export
              </button>
            </div>
          </div>
          {/* Import option */}
          <div style={{border:'0.5px solid rgba(60,60,67,0.2)',borderRadius:14,padding:'18px 20px'}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:14}}>
              <div style={{flex:1}}>
                <div style={{fontWeight:700,fontSize:14,marginBottom:4,display:'flex',alignItems:'center',gap:7}}><Upload size={15}/>Import Job Board</div>
                <p style={{fontSize:12,color:'rgba(60,60,67,0.65)',lineHeight:1.65}}>
                  Load a previously exported <code style={{background:'#F2F2F7',padding:'1px 5px',borderRadius:3}}>json</code> file. Everything in the app will be replaced with the imported session. You will be warned before anything is overwritten.
                </p>
              </div>
              <button onClick={()=>fileRef.current?.click()} style={{flexShrink:0,padding:'9px 16px',background:'transparent',color:'#000000',border:'0.5px solid rgba(60,60,67,0.2)',borderRadius:10,cursor:'pointer',fontWeight:700,fontSize:13,display:'flex',alignItems:'center',gap:6}}>
                <Upload size={14}/>Import
              </button>
            </div>
            <input ref={fileRef} type="file" accept=".json" style={{display:'none'}} onChange={handleFileSelect}/>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Terms & Conditions Modal ───────────────────────────────────────────────
function TermsModal({onClose}:{onClose:()=>void;}) {
  const sections=[
    {
      title:'1. Overview',
      body:`This application ("Ape X Job Hunt," "the App") is a personal productivity tool. By accessing or using the App, you agree to be bound by these Terms and Conditions. If you do not agree, do not use the App.`,
    },
    {
      title:'2. Nature of the Application',
      body:`The App is a client-side web application designed to assist users in discovering, tracking, and applying to job opportunities. The App interfaces with third-party services including AI APIs and search APIs to perform job searches and generate application documents.`,
    },
    {
      title:'3. No Employment Guarantee',
      body:`The App does not guarantee employment outcomes. Job listings surfaced by the App are sourced from third-party job boards and search engines. No representations are made regarding the accuracy, completeness, timeliness, or availability of any job listing, salary estimate, or company information presented in the App. All job data should be independently verified before acting upon it.`,
    },
    {
      title:'4. Local Storage & Data Handling',
      body:`The App stores all user data exclusively in your browser's localStorage. This includes: your candidate profile, uploaded resume and cover letter content, job search results, application history, instruction sets, search history, and API keys. No data is transmitted to or stored on external servers. When you clear your browser data or use the Reset All function, all stored data is permanently deleted. It is your responsibility to export and back up your data using the Save/Import feature.`,
    },
    {
      title:'5. API Keys & Third-Party Services',
      body:`You are solely responsible for obtaining, securing, and managing your own API keys. API keys are stored in your browser's localStorage and, if exported, in your export file. Treat your API keys as passwords — do not share them or store them in unsecured locations. The App is not responsible for unauthorized use of your API keys, charges incurred through your API accounts, or changes to third-party API pricing, availability, or terms of service. Your use of those services is governed by their respective terms.`,
    },
    {
      title:'6. Intellectual Property',
      body:`Job listings, company information, and external content remain the property of their respective owners. The App does not claim ownership over any third-party content it surfaces. Generated resume and cover letter documents are produced based on your own input data and templates; you retain all rights to documents generated using your own materials.`,
    },
    {
      title:'7. Disclaimer of Warranties',
      body:`THE APP IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT. THE APP DOES NOT WARRANT THAT IT WILL BE UNINTERRUPTED, ERROR-FREE, OR FREE OF HARMFUL COMPONENTS. YOUR USE OF THE APP IS ENTIRELY AT YOUR OWN RISK.`,
    },
    {
      title:'8. Limitation of Liability',
      body:`TO THE FULLEST EXTENT PERMITTED BY APPLICABLE LAW, THE APP AND ITS OPERATORS SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES ARISING FROM YOUR USE OF OR INABILITY TO USE THE APP, INCLUDING BUT NOT LIMITED TO LOSS OF DATA, LOSS OF EMPLOYMENT OPPORTUNITIES, OR LOSS OF BUSINESS, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.`,
    },
    {
      title:'9. Indemnification',
      body:`You agree to indemnify, defend, and hold harmless the App and its operators from and against any claims, liabilities, damages, losses, and expenses, including reasonable legal fees, arising out of or in any way connected with: (a) your access to or use of the App; (b) your violation of these Terms; (c) your violation of any third-party right, including any intellectual property or privacy right; or (d) any claim that your use of the App caused damage to a third party.`,
    },
    {
      title:'10. Third-Party Services',
      body:`The App integrates with third-party AI and search APIs. Your use of these services is subject to their own terms of service and privacy policies. The App is not affiliated with, endorsed by, or in partnership with any third-party service provider, job board, or employer whose listings may appear in the App. Links to third-party websites are provided for convenience only; the App does not endorse and is not responsible for the content of those sites.`,
    },
    {
      title:'11. Privacy',
      body:`The App does not collect, transmit, or store any personal data on external servers. All data remains in your browser's localStorage on your device. The App does not use cookies, tracking pixels, analytics services, or advertising. The only external network requests made by the App are direct API calls to your configured services using your own API keys, and web search requests on your behalf when you initiate a job search.`,
    },
    {
      title:'12. Modifications',
      body:`The App operators reserve the right to modify these Terms at any time. Continued use of the App following any modification constitutes acceptance of the revised Terms. It is your responsibility to review these Terms periodically.`,
    },
    {
      title:'13. Governing Law',
      body:`These Terms shall be governed by and construed in accordance with applicable law. Any dispute arising from these Terms or your use of the App shall be subject to applicable jurisdiction.`,
    },
    {
      title:'14. Contact',
      body:`For questions regarding these Terms, please contact the application developer.`,
    },
  ];

  return (
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.7)',zIndex:1000,display:'flex',alignItems:'center',justifyContent:'center',padding:'24px',overflow:'hidden'}}>
      <div style={{background:'#fff',borderRadius:14,width:'100%',maxWidth:720,maxHeight:'90vh',boxShadow:'0 16px 64px rgba(0,0,0,0.25)',display:'flex',flexDirection:'column',overflow:'hidden'}}>
        <div style={{padding:'24px 28px 18px',borderBottom:'3px solid #000000',display:'flex',justifyContent:'space-between',alignItems:'flex-start',flexShrink:0}}>
          <div>
            <div style={{fontSize:10,letterSpacing:'0.18em',textTransform:'uppercase',color:'#007AFF',fontWeight:700,marginBottom:6}}>Legal</div>
            <h1 style={{fontSize:26,fontWeight:400,lineHeight:1.1}}>Terms &amp; Conditions</h1>
            <p style={{fontSize:12,color:'rgba(60,60,67,0.6)',marginTop:6}}>Ape X Job Hunt Application · Last updated May 2026</p>
          </div>
          <button onClick={onClose} style={{background:'none',border:'none',cursor:'pointer',color:'rgba(60,60,67,0.5)',padding:4,flexShrink:0}}><X size={22}/></button>
        </div>
        <div style={{padding:'24px 28px 32px',display:'flex',flexDirection:'column',gap:22,overflowY:'auto',flex:1}}>
          <div style={{background:'rgba(255,59,48,0.04)',border:'0.5px solid rgba(255,59,48,0.2)',borderRadius:10,padding:'12px 16px',fontSize:12,color:'#D70015',lineHeight:1.7,flexShrink:0}}>
            <strong>Please read these Terms carefully.</strong> By using the Ape X Job Hunt application, you acknowledge that you have read, understood, and agree to be bound by these Terms and Conditions and all applicable laws.
          </div>
          {sections.map(s=>(
            <div key={s.title}>
              <h3 style={{fontSize:16,fontWeight:400,marginBottom:8,color:'#000000'}}>{s.title}</h3>
              <p style={{fontSize:13,color:'rgba(60,60,67,0.85)',lineHeight:1.75}}>{s.body}</p>
            </div>
          ))}
          <div style={{borderTop:'0.5px solid rgba(60,60,67,0.2)',paddingTop:18,fontSize:12,color:'rgba(60,60,67,0.6)',lineHeight:1.7}}>
            These Terms and Conditions were last updated May 2026 and are effective immediately. By continuing to use the Ape X Job Hunt application, you agree to these terms in their entirety.
          </div>
        </div>
        <div style={{padding:'16px 28px',borderTop:'0.5px solid rgba(60,60,67,0.2)',display:'flex',justifyContent:'flex-end',flexShrink:0,background:'#fff'}}>
          <button onClick={onClose} style={{padding:'10px 24px',background:'#000000',color:'#fff',border:'none',borderRadius:10,cursor:'pointer',fontWeight:700,fontSize:14}}>Close</button>
        </div>
      </div>
    </div>
  );
}


// ── Main App ───────────────────────────────────────────────────────────────
export default function Home() {
  const [tab,setTab]=useState<Tab>('search');
  const [jobs,setJobs]=useState<SavedJob[]>([]);
  const [excludedJobs,setExcludedJobs]=useState<ExcludedJob[]>([]);
  const [appliedJobs,setAppliedJobs]=useState<AppliedJob[]>([]);
  const [searching,setSearching]=useState(false);
  const [searchError,setSearchError]=useState('');
  const [showHowTo,setShowHowTo]=useState(false);
  const [showSpecial,setShowSpecial]=useState(false);
  const [showReset,setShowReset]=useState(false);
  const [showClearBoard,setShowClearBoard]=useState(false);
  const [showWizard,setShowWizard]=useState(false);
  const [showSuccess,setShowSuccess]=useState(false);
  const [showWelcome,setShowWelcome]=useState(false);
  const [searchPhase,setSearchPhase]=useState<1|2>(1);
  const [showMobileFAB,setShowMobileFAB]=useState(false);
  const [showHistory,setShowHistory]=useState(false);
  const [showHistoryFull,setShowHistoryFull]=useState(false);
  const [showDeleteOldest,setShowDeleteOldest]=useState(false);
  const [showManageHistory,setShowManageHistory]=useState(false);
  const [pendingSearch,setPendingSearch]=useState(false);
  const [analyzingJob,setAnalyzingJob]=useState<string|null>(null);
  const [analyzeModal,setAnalyzeModal]=useState<ExcludedJob|null>(null);
  const [analyzeResult,setAnalyzeResult]=useState<Record<string,unknown>|null>(null);
  const [analyzeLoadingVisible,setAnalyzeLoadingVisible]=useState(false);
  const [searchHistory,setSearchHistory]=useState<SearchSnapshot[]>([]);
  const [resetInstrTarget,setResetInstrTarget]=useState<'jobSearch'|'resume'|'coverLetter'|null>(null);
  const [specialInstructions,setSpecialInstructions]=useState('');
  const [generateModal,setGenerateModal]=useState<{job:SavedJob;type:GenerateType}|null>(null);
  const [generatingJobs]=useState<Record<string,GenerateType>>({});
  const [addStatusModal,setAddStatusModal]=useState<string|null>(null);
  const [filterCat,setFilterCat]=useState('all');
  const [filterRemote,setFilterRemote]=useState<boolean|'notremote'>(false);
  const [sortBy,setSortBy]=useState<'salary'|'rating'>('salary');
  const [jobSearchInstr,setJobSearchInstr]=useState('');
  const [resumeInstr,setResumeInstr]=useState('');
  const [coverInstr,setCoverInstr]=useState('');
  const [anthropicKey,setAnthropicKey]=useState('');
  const [serperKey,setSerperKey]=useState('');
  const [aiProvider,setAiProvider]=useState<AIProvider>('claude');
  const [keysSaved,setKeysSaved]=useState(false);
  const [instrSaved,setInstrSaved]=useState<string|null>(null);
  const [copied,setCopied]=useState<string|null>(null);
  const [resumeMeta,setResumeMeta]=useState<UploadMeta|null>(null);
  const [coverMeta,setCoverMeta]=useState<UploadMeta|null>(null);
  const [profile,setProfile]=useState<CandidateProfile>(DEFAULT_PROFILE);
  const [historyToDelete,setHistoryToDelete]=useState<Set<string>>(new Set());
  const [showSaveImport,setShowSaveImport]=useState(false);
  const [showTerms,setShowTerms]=useState(false);
  const abortRef=useRef(false);

  useEffect(()=>{
    const saved=getSavedInstructions();
    setJobSearchInstr(saved?.jobSearch||DEFAULT_JOB_SEARCH_INSTRUCTIONS);
    setResumeInstr(saved?.resume||DEFAULT_RESUME_INSTRUCTIONS);
    setCoverInstr(saved?.coverLetter||DEFAULT_COVER_LETTER_INSTRUCTIONS);
    setJobs(getSavedJobs()); setAppliedJobs(getAppliedJobs());
    // Load provider FIRST, then load that provider's specific key.
    const provider=getAIProvider();
    setAiProvider(provider);
    setAnthropicKey(getApiKey(provider));
    setSerperKey(getLocalSerperKey());
    setResumeMeta(getUploadedResumeMeta()); setCoverMeta(getUploadedCoverMeta());
    const p=getSavedProfile(); if(p) setProfile(p);
    setSearchHistory(getSearchHistory());
    if(!getWizardSeen()) setShowWelcome(true);
  },[]);

  // When the user changes provider on the Settings tab, auto-load that
  // provider's stored key (so switching shows the saved key without re-entry).
  useEffect(()=>{
    const stored=getApiKey(aiProvider);
    setAnthropicKey(stored);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[aiProvider]);

  useEffect(()=>{if(tab==='applied')setAppliedJobs(getAppliedJobs());},[tab]);
  useEffect(()=>{if(!generateModal)setAppliedJobs(getAppliedJobs());},[generateModal]);
  useEffect(()=>{if(!addStatusModal)setAppliedJobs(getAppliedJobs());},[addStatusModal]);

  const doRunSearch=async()=>{
    setSearchError('');abortRef.current=false;setSearching(true);

    try{
      let live:SavedJob[]=[];
      let excl:ExcludedJob[]=[];
      const today=new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'});

      if(aiProvider==='gemini'){
        // ── Gemini: job bot single-pass — Serper only, no AI in search loop ──
        setSearchPhase(1);
        const res=await fetch('/ape/api/search-gemini',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({instructions:jobSearchInstr,serperKeyOverride:serperKey})});
        if(abortRef.current) return;
        const data=await safeJson(res);
        if(!res.ok){setSearchError((data.error as string)||'Search failed.');setSearching(false);return;}
        const rawJobs=Array.isArray(data.jobs)?data.jobs as {title:string;link:string;snippet:string;source:string}[]:[];
        live=rawJobs.map((r,i)=>{
          const slug=`${r.source}-${i}-${Date.now()}`;
          return {
            id:slug,
            company:r.source,
            title:r.title,
            category:'manager',
            isRemote:true,
            isHybrid:false,
            isOnsite:false,
            location:'',
            industry:[],
            salaryMin:0,
            salaryMax:0,
            salaryDisplay:'Not Listed',
            salaryNote:'Not Listed',
            rating:7,
            auditLabel:`✓ ATS Verified ${today}`,
            roleSummary:r.snippet,
            whyYouFit:[],
            requirements:[],
            companyInfo:'',
            goldFlags:[],
            redFlags:[],
            applyUrl:r.link,
            careersUrl:r.link,
            aboutUrl:'',
            jobDescUrl:r.link,
            postedDate:'',
            excluded:false,
          };
        });
        excl=[];

      }else{
        // ── Claude: original two-pass verified search (verbatim from CL007-v1) ──
        setSearchPhase(1);
        const res1=await fetch('/ape/api/search-pass1',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({instructions:jobSearchInstr,specialInstructions,apiKeyOverride:anthropicKey,serperKeyOverride:serperKey,aiProvider})});
        if(abortRef.current) return;
        const data1=await safeJson(res1);
        if(!res1.ok){setSearchError((data1.error as string)||'Search failed in Pass 1.');setSearching(false);return;}
        if(data1.error==='no_results'){setSearchError((data1.message as string)||'No results found.');setSearching(false);return;}

        setSearchPhase(2);
        const res2=await fetch('/ape/api/search-pass2',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({
            trusted:data1.trusted||[],
            aggregators:data1.aggregators||[],
            instructions:jobSearchInstr,
            specialInstructions,
            apiKeyOverride:anthropicKey,
            serperKeyOverride:serperKey,
            titlesSearched:data1.titlesSearched||[],
            aiProvider,
          })});
        if(abortRef.current) return;
        const data2=await safeJson(res2);
        if(!res2.ok){setSearchError((data2.error as string)||'Search failed in Pass 2.');setSearching(false);return;}
        if(data2.error){setSearchError((data2.error as string)||'Search failed in Pass 2.');setSearching(false);return;}

        const allJobs=Array.isArray(data2.jobs)?data2.jobs as (SavedJob|ExcludedJob)[]:[];
        live=allJobs.filter((j:SavedJob|ExcludedJob)=>!j.excluded) as SavedJob[];
        excl=allJobs.filter((j:SavedJob|ExcludedJob)=>j.excluded) as ExcludedJob[];
      }

      setJobs(live);setExcludedJobs(excl);setSavedJobs(live);
      setLastSearchQuery(jobSearchInstr);

      const snap:SearchSnapshot={
        id:`search-${Date.now()}`,
        title:profile.targetTitles.slice(0,2).join(' / ')||'Job Search',
        timestamp:new Date().toISOString(),
        jobs:live,
        excludedJobs:excl as ExcludedJobSnapshot[],
        searchMeta:{
          targetTitles:profile.targetTitles,
          workTypes:profile.workTypes,
          locations:profile.locations,
          salaryMin:profile.salaryMin,
          salaryMax:profile.salaryMax,
          jobCount:live.length,
        },
      };
      saveSearchToHistory(snap);
      setSearchHistory(getSearchHistory());
      setTab('board');
    }catch(e:unknown){if(!abortRef.current)setSearchError(e instanceof Error?e.message:'Unknown error');}
    finally{setSearching(false);}
  };
  const runSearch=async()=>{
    // Frontend location validation
    if(profile.locations && profile.locations.length>0){
      const locValidation=validateAllLocations(profile.locations);
      if(!locValidation.valid){
        setSearchError(locValidation.error||'Invalid location format.');
        return;
      }
    }
    if(isHistoryFull()){
      setShowHistoryFull(true);
      setPendingSearch(true);
      return;
    }
    await doRunSearch();
  };

  const handleUpload=async(file:File,type:'resume'|'cover')=>{
    const content=await parseFile(file);
    const dataUri=await fileToDataUri(file);
    const ext=file.name.split('.').pop()?.toLowerCase() as UploadMeta['fileType'];
    const meta:UploadMeta={filename:file.name,uploadedAt:new Date().toISOString(),fileType:ext};
    if(type==='resume'){setUploadedResume(content,meta);setUploadedResumeFileData(dataUri);setResumeMeta(meta);}
    else{setUploadedCover(content,meta);setUploadedCoverFileData(dataUri);setCoverMeta(meta);}
  };

  // Open modal immediately, start background analysis after modal renders
  const openAddToBoard=(excl:ExcludedJob)=>{
    analyzeResultRef.current=null;
    setAnalyzeResult(null);
    setAnalyzeModal(excl);
    setAnalyzingJob(excl.id);
    // Fire analysis in background
    fetch('/ape/api/analyze-job',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        company:excl.company,title:excl.title,
        applyUrl:excl.applyUrl,jobDescUrl:excl.jobDescUrl,careersUrl:excl.careersUrl,
        candidateProfile:profile,jdText:'',apiKeyOverride:anthropicKey,aiProvider,
      }),
    }).then(r=>safeJson(r)).then(data=>{
      analyzeResultRef.current=data;
      setAnalyzeResult(data);
      setAnalyzingJob(null);
    }).catch(()=>{
      const errResult={error:true};
      analyzeResultRef.current=errResult;
      setAnalyzeResult(errResult);
      setAnalyzingJob(null);
    });
  };

  const promoteToBoard=(excl:ExcludedJob,jdText:string,analysisData:Record<string,unknown>|null)=>{
    const analysis=(analysisData&&!analysisData.error)?analysisData.analysis as Record<string,unknown>:{};
    const promoted:SavedJob={
      id:excl.id,company:excl.company,title:excl.title,
      category:(analysis.category as string)||excl.category||'director',
      isRemote:(analysis.isRemote as boolean)??excl.isRemote??false,
      isHybrid:(analysis.isHybrid as boolean)??excl.isHybrid??false,
      isOnsite:(analysis.isOnsite as boolean)??false,
      location:(analysis.location as string)||'',
      industry:(analysis.industry as string[])||excl.industry||[],
      salaryMin:(analysis.salaryMin as number)||excl.salaryMin||0,
      salaryMax:(analysis.salaryMax as number)||excl.salaryMax||0,
      salaryDisplay:(analysis.salaryDisplay as string)||excl.salaryDisplay||'N/A',
      salaryNote:(analysis.salaryNote as string)||excl.salaryNote||'Estimated',
      rating:(analysis.rating as number)||excl.rating||6,
      auditLabel:'Manually Added',
      roleSummary:(analysis.roleSummary as string)||excl.roleSummary||'',
      whyYouFit:(analysis.whyYouFit as string[])||excl.whyYouFit||[],
      requirements:(analysis.requirements as string[])||excl.requirements||[],
      companyInfo:(analysis.companyInfo as string)||excl.companyInfo||'',
      goldFlags:(analysis.goldFlags as string[])||excl.goldFlags||[],
      redFlags:(analysis.redFlags as string[])||excl.redFlags||[],
      applyUrl:excl.applyUrl||'#',careersUrl:excl.careersUrl||'#',
      aboutUrl:excl.careersUrl||'#',jobDescUrl:excl.jobDescUrl||'#',
      postedDate:excl.postedDate||'',excluded:false,
      manuallyAdded:true,
      originalExclusion:{layerFailed:excl.layerFailed,reason:excl.reason},
    } as SavedJob & {isOnsite?:boolean;location?:string;manuallyAdded?:boolean;originalExclusion?:{layerFailed:string;reason:string}};
    const updated=[...jobs,promoted];setJobs(updated);setSavedJobs(updated);
    setExcludedJobs(prev=>prev.filter(j=>j.id!==excl.id));
    setAnalyzeModal(null);setAnalyzeResult(null);setAnalyzingJob(null);
    setAnalyzeLoadingVisible(false);
  };

  const analyzeResultRef=useRef<Record<string,unknown>|null>(null);
  const handleContinueAddToBoard=(jdText:string)=>{
    if(!analyzeModal) return;
    const excl=analyzeModal;
    if(analyzingJob===excl.id){
      // Analysis still running — show loading screen, wait for result
      setAnalyzeLoadingVisible(true);
      const interval=setInterval(()=>{
        const result=analyzeResultRef.current;
        if(result!==null){
          clearInterval(interval);
          promoteToBoard(excl,jdText,result);
        }
      },300);
    } else {
      // Analysis already done
      promoteToBoard(excl,jdText,analyzeResult);
    }
  };

  const returnToExcluded=(job:SavedJob)=>{
    const orig=(job as SavedJob&{originalExclusion?:{layerFailed:string;reason:string}}).originalExclusion;
    const excluded:ExcludedJob={
      id:job.id,company:job.company,title:job.title,
      layerFailed:orig?.layerFailed||'Layer 1',
      reason:orig?.reason||'Manually removed from board',
      excluded:true,
      applyUrl:job.applyUrl,careersUrl:job.careersUrl,jobDescUrl:job.jobDescUrl,
      category:job.category,isRemote:job.isRemote,isHybrid:job.isHybrid,
      industry:job.industry,salaryDisplay:job.salaryDisplay,rating:job.rating,
    };
    setExcludedJobs(prev=>[...prev,excluded]);
    const updated=jobs.filter(j=>j.id!==job.id);
    setJobs(updated);setSavedJobs(updated);
  };


  const saveInstrs=(which:'jobSearch'|'resume'|'coverLetter')=>{
    const obj=getSavedInstructions()||{jobSearch:jobSearchInstr,resume:resumeInstr,coverLetter:coverInstr};
    if(which==='jobSearch')obj.jobSearch=jobSearchInstr;
    if(which==='resume')obj.resume=resumeInstr;
    if(which==='coverLetter')obj.coverLetter=coverInstr;
    saveInstructions(obj);setInstrSaved(which);setTimeout(()=>setInstrSaved(null),2500);
  };

  const copyInstrs=async(which:'jobSearch'|'resume'|'coverLetter')=>{
    const text=which==='jobSearch'?jobSearchInstr:which==='resume'?resumeInstr:coverInstr;
    await navigator.clipboard.writeText(text);
    setCopied(which);setTimeout(()=>setCopied(null),2000);
  };

  const resetSingleInstr=(which:'jobSearch'|'resume'|'coverLetter')=>{
    const def=which==='jobSearch'?buildJobSearchInstructions(profile):which==='resume'?buildResumeInstructions(profile):buildCoverLetterInstructions(profile);
    if(which==='jobSearch')setJobSearchInstr(def);
    if(which==='resume')setResumeInstr(def);
    if(which==='coverLetter')setCoverInstr(def);
    saveInstrs(which);setResetInstrTarget(null);
  };

  const doReset=()=>{
    clearAllStorage(); // wipes ALL localStorage — nothing survives
    // Reset every piece of React state to blank defaults
    setJobs([]);
    setExcludedJobs([]);
    setAppliedJobs([]);
    setSearchHistory([]);
    setJobSearchInstr(DEFAULT_JOB_SEARCH_INSTRUCTIONS);
    setResumeInstr(DEFAULT_RESUME_INSTRUCTIONS);
    setCoverInstr(DEFAULT_COVER_LETTER_INSTRUCTIONS);
    setAnthropicKey('');
    setSerperKey('');
    setResumeMeta(null);
    setCoverMeta(null);
    setProfile(DEFAULT_PROFILE);
    setSpecialInstructions('');
    setFilterCat('all');
    setFilterRemote(false);
    setSortBy('salary');
    setShowReset(false);
    setTab('search');
  };

  const onWizardComplete=(p:CandidateProfile,anthKey:string,serpKey:string,provider:AIProvider)=>{
    // Persist key to PROVIDER-SPECIFIC slot so both Claude and Gemini keys
    // can coexist and be auto-loaded when switching providers.
    setApiKey(provider,anthKey);
    setLocalSerperKey(serpKey);
    setAIProvider(provider);
    // Build and persist instructions
    const js=buildJobSearchInstructions(p);
    const res=buildResumeInstructions(p);
    const cv=buildCoverLetterInstructions(p);
    saveInstructions({jobSearch:js,resume:res,coverLetter:cv});
    // Update React state
    setProfile(p);
    setAnthropicKey(anthKey); setSerperKey(serpKey); setAiProvider(provider);
    setJobSearchInstr(js);
    setResumeInstr(res);
    setCoverInstr(cv);
    setWizardSeen();
    setShowWizard(false);setShowSuccess(true);
  };

  const displayJobs=jobs
    .filter(j=>{
      if(filterRemote===true) return j.isRemote;
      if(filterRemote==='notremote') return !j.isRemote;
      return true;
    })
    .sort((a,b)=>{
      if(sortBy==='rating') return (b.rating||0)-(a.rating||0)||(b.postedDate||'').localeCompare(a.postedDate||'');
      if((sortBy as string)==='salaryAsc') return (a.salaryMin||0)-(b.salaryMin||0);
      if((sortBy as string)==='recent') return (b.postedDate||'').localeCompare(a.postedDate||'');
      return (b.salaryMax||0)-(a.salaryMax||0);
    });
  // Dynamic categories from actual returned data
  const allCategories=Array.from(new Set(displayJobs.map(j=>j.category||'Other')));
  const categoryGroups=allCategories.map(cat=>({
    cat,
    list:displayJobs.filter(j=>(j.category||'Other')===cat),
  })).filter(g=>g.list.length>0);

  const instrName=(k:'jobSearch'|'resume'|'coverLetter')=>k==='jobSearch'?'Job Search Instructions':k==='resume'?'Resume Instructions':'Cover Letter Instructions';

  return (
    <div style={{minHeight:'100vh',background:'#F2F2F7',display:'flex',flexDirection:'column'}}>
      <style>{`
        @keyframes fadeIn{from{opacity:0}to{opacity:1}}
        @keyframes slideInRight{from{transform:translateX(100%)}to{transform:translateX(0)}}
        @keyframes slideUpSheet{from{transform:translateY(100%)}to{transform:translateY(0)}}
        @keyframes apulse{0%,100%{opacity:0.3;transform:scale(0.8)}50%{opacity:1;transform:scale(1)}}
        *{box-sizing:border-box;}
        ::-webkit-scrollbar{width:5px;}
        ::-webkit-scrollbar-thumb{background:#C7C7CC;border-radius:3px;}
        @media(max-width:767px){
          .nav-label{display:none!important;}
          .main-pad{padding:20px 16px 80px!important;}
          .header-inner{padding:0 16px!important;}
          .wizard-grid{grid-template-columns:1fr!important;}
          .provider-toggle{grid-template-columns:1fr!important;}
        }
        @media(min-width:768px){.mobile-only{display:none!important;}}
      `}</style>

      {searching&&<LoadingOverlay
        onCancel={()=>{abortRef.current=true;setSearching(false);}}
        minutesEta={6}
        phaseMessage={searchPhase===1?'Sending the apes out to search...':'Verifying listings across company pages...'}
      />}
      {showHowTo&&<HowToDrawer onClose={()=>setShowHowTo(false)}/>}
      {showSpecial&&<SpecialModal value={specialInstructions} onChange={setSpecialInstructions} onClose={()=>setShowSpecial(false)}/>}
      {showReset&&<ConfirmModal title="Are you certain?" body="This will reset ALL data including saved jobs, applied history, uploaded templates, API keys, profile, and all instructions. This is not reversible." confirmLabel="Reset Everything" onConfirm={doReset} onClose={()=>setShowReset(false)}/>}
      {resetInstrTarget&&<ConfirmModal title="Reset Instructions?" body={`This will reset your ${instrName(resetInstrTarget)} to the profile-based default. This is not reversible.`} confirmLabel="Reset" onConfirm={()=>resetSingleInstr(resetInstrTarget)} onClose={()=>setResetInstrTarget(null)}/>}
      {showWizard&&<SetupWizard initialProfile={profile} initialAnthropicKey={anthropicKey} initialSerperKey={serperKey} initialProvider={aiProvider} onComplete={onWizardComplete} onClose={()=>setShowWizard(false)} onOpenHowTo={()=>setShowHowTo(true)}/>}
      {showSuccess&&<SuccessModal onSearch={()=>{setShowSuccess(false);runSearch();}} onClose={()=>setShowSuccess(false)}/>}
      {showWelcome&&<WelcomeModal onBegin={()=>{setWizardSeen();setShowWelcome(false);setShowWizard(true);}} onSkip={()=>{setWizardSeen();setShowWelcome(false);}}/>}
      {showMobileFAB&&<MobileFAB instructions={jobSearchInstr} onClose={()=>setShowMobileFAB(false)}/>}
      {generateModal&&<GenerateModal job={generateModal.job} type={generateModal.type} instructions={generateModal.type==='resume'?resumeInstr:coverInstr} apiKey={anthropicKey} aiProvider={aiProvider} onClose={()=>setGenerateModal(null)}/>}
      {addStatusModal&&<AddStatusModal jobId={addStatusModal} onClose={()=>setAddStatusModal(null)}/>}
      {showClearBoard&&<ConfirmModal title="Delete All Jobs?" body="This will permanently remove all jobs from the board. This cannot be undone." confirmLabel="Delete" onConfirm={()=>{clearSavedJobs();setJobs([]);setExcludedJobs([]);setShowClearBoard(false);}} onClose={()=>setShowClearBoard(false)}/>}
      {showSaveImport&&<SaveImportModal onClose={()=>setShowSaveImport(false)} onImportComplete={()=>{window.location.reload();}}/>}
      {showTerms&&<TermsModal onClose={()=>setShowTerms(false)}/>}

      {/* History Full Modal */}
      {showHistoryFull&&(
        <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.4)',backdropFilter:'blur(12px)',WebkitBackdropFilter:'blur(12px)',zIndex:800,display:'flex',alignItems:'center',justifyContent:'center',padding:20}}>
          <div style={{background:'rgba(255,255,255,0.96)',borderRadius:20,width:'100%',maxWidth:420,boxShadow:'0 20px 60px rgba(0,0,0,0.2)',padding:28,textAlign:'center',border:'0.5px solid rgba(255,255,255,0.8)'}}>
            <div style={{width:52,height:52,borderRadius:'50%',background:'rgba(255,149,0,0.12)',display:'flex',alignItems:'center',justifyContent:'center',margin:'0 auto 14px'}}><AlertTriangle size={24} color="#FF9500"/></div>
            <h2 style={{fontSize:20,fontWeight:700,letterSpacing:'-0.02em',marginBottom:8,color:'#000'}}>Saved Search List Full</h2>
            <p style={{fontSize:13,color:'rgba(60,60,67,0.6)',lineHeight:1.7,marginBottom:24}}>You have 5 saved searches. Continuing will auto-delete the oldest search, or you can remove one of your choice.</p>
            <div style={{display:'flex',gap:10,justifyContent:'center',flexWrap:'wrap'}}>
              <button onClick={()=>{setShowHistoryFull(false);setShowDeleteOldest(true);}} style={{padding:'10px 18px',background:'#FF9500',color:'#fff',border:'none',borderRadius:50,cursor:'pointer',fontWeight:600,fontSize:13}}>Proceed (delete oldest)</button>
              <button onClick={()=>{setShowHistoryFull(false);setPendingSearch(false);}} style={{padding:'10px 18px',background:'rgba(120,120,128,0.1)',color:'#000',border:'none',borderRadius:50,cursor:'pointer',fontWeight:600,fontSize:13}}>Cancel</button>
              <button onClick={()=>{setShowHistoryFull(false);setShowManageHistory(true);}} style={{padding:'10px 18px',background:'rgba(0,0,0,0.08)',color:'#000',border:'none',borderRadius:50,cursor:'pointer',fontWeight:600,fontSize:13}}>Delete a Search</button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Oldest Confirm */}
      {showDeleteOldest&&<ConfirmModal title="Delete Oldest Search?" body="This will permanently delete your oldest saved search and cannot be undone." confirmLabel="Delete & Proceed" onConfirm={async()=>{deleteOldestSearch();setSearchHistory(getSearchHistory());setShowDeleteOldest(false);if(pendingSearch){setPendingSearch(false);await doRunSearch();}}} onClose={()=>{setShowDeleteOldest(false);setPendingSearch(false);}}/>}

      {/* Manage History Modal */}
      {showManageHistory&&(
        <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.6)',zIndex:800,display:'flex',alignItems:'center',justifyContent:'center',padding:24}}>
          <div style={{background:'#fff',borderRadius:10,width:'100%',maxWidth:560,maxHeight:'80vh',overflowY:'auto',boxShadow:'0 8px 32px rgba(0,0,0,0.2)'}}>
            <div style={{padding:'18px 22px 14px',borderBottom:'0.5px solid rgba(60,60,67,0.2)',display:'flex',justifyContent:'space-between',alignItems:'center',position:'sticky',top:0,background:'#fff'}}>
              <h2 style={{fontSize:18,fontWeight:700,letterSpacing:'-0.02em',color:'#000'}}>Manage Saved Searches</h2>
              <button onClick={()=>{setShowManageHistory(false);setHistoryToDelete(new Set());}} style={{background:'none',border:'none',cursor:'pointer',color:'rgba(60,60,67,0.5)'}}><X size={19}/></button>
            </div>
            <div style={{padding:22}}>
              <p style={{fontSize:12,color:'#FF3B30',marginBottom:16,display:'flex',alignItems:'center',gap:6,fontWeight:500}}><AlertTriangle size={12}/>Deletion cannot be undone.</p>
              {searchHistory.map(snap=>(
                <div key={snap.id} style={{background:historyToDelete.has(snap.id)?'rgba(255,59,48,0.04)':'#F2F2F7',border:`1px solid ${historyToDelete.has(snap.id)?'rgba(255,59,48,0.2)':'rgba(60,60,67,0.15)'}`,borderRadius:10,padding:'12px 14px',marginBottom:10,display:'flex',justifyContent:'space-between',alignItems:'center',gap:12}}>
                  <div style={{flex:1}}>
                    <div style={{fontWeight:700,fontSize:13,marginBottom:3}}>{snap.title}</div>
                    <div style={{fontSize:11,color:'rgba(60,60,67,0.6)'}}>{new Date(snap.timestamp).toLocaleString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'})} · {snap.searchMeta.jobCount} jobs</div>
                  </div>
                  <input type="checkbox" checked={historyToDelete.has(snap.id)} onChange={e=>{const s=new Set(historyToDelete);e.target.checked?s.add(snap.id):s.delete(snap.id);setHistoryToDelete(s);}} style={{width:16,height:16,cursor:'pointer',accentColor:'#007AFF'}}/>
                </div>
              ))}
            </div>
            <div style={{padding:'14px 22px',borderTop:'0.5px solid rgba(60,60,67,0.2)',display:'flex',gap:10,justifyContent:'flex-end',position:'sticky',bottom:0,background:'#fff'}}>
              {historyToDelete.size>0&&<button onClick={async()=>{historyToDelete.forEach(id=>deleteSearchFromHistory(id));setSearchHistory(getSearchHistory());setHistoryToDelete(new Set());setShowManageHistory(false);if(pendingSearch&&!isHistoryFull()){setPendingSearch(false);await doRunSearch();}}} style={{padding:'9px 18px',background:'#FF3B30',color:'#fff',border:'none',borderRadius:50,cursor:'pointer',fontWeight:600,fontSize:13}}>Delete Selected ({historyToDelete.size})</button>}
              <button onClick={()=>{setShowManageHistory(false);setHistoryToDelete(new Set());setPendingSearch(false);}} style={{padding:'9px 18px',background:'rgba(120,120,128,0.1)',color:'#000',border:'none',borderRadius:50,cursor:'pointer',fontWeight:600,fontSize:13}}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Saved Searches Modal */}
      {showHistory&&(
        <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.5)',zIndex:700,display:'flex',alignItems:'center',justifyContent:'center',padding:24}}>
          <div style={{background:'#fff',borderRadius:10,width:'100%',maxWidth:580,maxHeight:'80vh',overflowY:'auto',boxShadow:'0 8px 32px rgba(0,0,0,0.14)'}}>
            <div style={{padding:'18px 22px 14px',borderBottom:'0.5px solid rgba(60,60,67,0.2)',display:'flex',justifyContent:'space-between',alignItems:'center',position:'sticky',top:0,background:'#fff'}}>
              <div>
                <h2 style={{fontSize:20,marginBottom:4}}>Saved Searches</h2>
                <div style={{fontSize:12,color:'rgba(60,60,67,0.5)',fontWeight:500}}>{searchHistory.length} of 5 saved ({5-searchHistory.length} available)</div>
              </div>
              <button onClick={()=>setShowHistory(false)} style={{background:'none',border:'none',cursor:'pointer',color:'rgba(60,60,67,0.5)'}}><X size={19}/></button>
            </div>
            <div style={{padding:22}}>
              {searchHistory.length===0?<p style={{fontSize:13,color:'rgba(60,60,67,0.6)',textAlign:'center',padding:'24px 0'}}>No saved searches yet. Run a search to get started.</p>:searchHistory.map((snap,idx)=>(
                <div key={snap.id} style={{background:'#F2F2F7',border:'none',borderRadius:14,padding:'16px 18px',marginBottom:10}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:12,flexWrap:'wrap'}}>
                    <div style={{flex:1}}>
                      <div style={{fontWeight:700,fontSize:14,marginBottom:4,letterSpacing:'-0.01em',color:'#000'}}>{snap.title}</div>
                      <div style={{fontSize:12,color:'rgba(60,60,67,0.45)',marginBottom:8}}>{new Date(snap.timestamp).toLocaleString('en-US',{weekday:'short',month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'})}</div>
                      <div style={{display:'flex',flexWrap:'wrap',gap:5}}>
                        <span style={{fontSize:10,fontWeight:700,background:'rgba(0,122,255,0.1)',color:'#007AFF',padding:'2px 7px',borderRadius:3}}>{snap.searchMeta.jobCount} verified jobs</span>
                        <span style={{fontSize:10,fontWeight:700,background:'rgba(255,204,0,0.12)',color:'#FF9500',padding:'2px 7px',borderRadius:3}}>{snap.searchMeta.workTypes.join(' · ')}</span>
                        {snap.searchMeta.locations.slice(0,3).map(l=><span key={l} style={{fontSize:10,fontWeight:700,background:'#F2F2F7',color:'rgba(60,60,67,0.65)',padding:'2px 7px',borderRadius:3}}>{l}</span>)}
                        <span style={{fontSize:10,fontWeight:700,background:'rgba(52,199,89,0.12)',color:'#1A7A3C',padding:'2px 7px',borderRadius:3}}>${(snap.searchMeta.salaryMin/1000).toFixed(0)}K–${(snap.searchMeta.salaryMax/1000).toFixed(0)}K</span>
                      </div>
                      {snap.searchMeta.targetTitles.length>0&&<div style={{fontSize:11,color:'rgba(60,60,67,0.65)',marginTop:6}}>{snap.searchMeta.targetTitles.slice(0,3).join(', ')}{snap.searchMeta.targetTitles.length>3&&` +${snap.searchMeta.targetTitles.length-3} more`}</div>}
                    </div>
                    <div style={{display:'flex',flexDirection:'column',gap:6,alignItems:'flex-end'}}>
                      <button onClick={()=>{setJobs(snap.jobs);setExcludedJobs(snap.excludedJobs as ExcludedJob[]);setSavedJobs(snap.jobs);setShowHistory(false);setTab('board');}} style={{padding:'7px 14px',background:'#007AFF',color:'#fff',border:'none',borderRadius:50,cursor:'pointer',fontWeight:600,fontSize:12,whiteSpace:'nowrap'}}>Restore</button>
                      <button onClick={()=>{deleteSearchFromHistory(snap.id);setSearchHistory(getSearchHistory());}} style={{padding:'5px 10px',background:'rgba(255,59,48,0.08)',color:'#FF3B30',border:'none',borderRadius:50,cursor:'pointer',fontSize:11,fontWeight:600,display:'flex',alignItems:'center',gap:4}}><Trash2 size={11}/>Delete</button>
                    </div>
                  </div>
                  {idx===searchHistory.length-1&&<div style={{fontSize:11,color:'#FF9500',marginTop:8,display:'flex',alignItems:'center',gap:4,fontWeight:500}}><AlertTriangle size={10}/>Oldest — will be auto-deleted if history is full</div>}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Analyze JD fallback modal */}
      {analyzeLoadingVisible&&(
        <LoadingOverlay dismissOnly onDismiss={()=>setAnalyzeLoadingVisible(false)} minutesEta={0.5}
          customMessage="Job being moved to board..."/>
      )}
      {analyzeModal&&!analyzeLoadingVisible&&(
        <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.5)',zIndex:600,display:'flex',alignItems:'center',justifyContent:'center',padding:24}}>
          <div style={{background:'#fff',borderRadius:10,width:'100%',maxWidth:560,boxShadow:'0 8px 32px rgba(0,0,0,0.14)'}}>
            <div style={{padding:'18px 22px 14px',borderBottom:'0.5px solid rgba(60,60,67,0.2)',display:'flex',justifyContent:'space-between'}}>
              <div>
                <div style={{fontSize:10,letterSpacing:'0.12em',textTransform:'uppercase',color:'#007AFF',fontWeight:700,marginBottom:4}}>Add to Board</div>
                <h2 style={{fontSize:18}}>{analyzeModal.company} — {analyzeModal.title}</h2>
              </div>
              <button onClick={()=>{setAnalyzeModal(null);setAnalyzingJob(null);setAnalyzeResult(null);}} style={{background:'none',border:'none',cursor:'pointer',color:'rgba(60,60,67,0.5)'}}><X size={19}/></button>
            </div>
            <AnalyzeJDInput excl={analyzeModal} onContinue={handleContinueAddToBoard} onClose={()=>{setAnalyzeModal(null);setAnalyzingJob(null);setAnalyzeResult(null);}}/>
          </div>
        </div>
      )}


      {/* HEADER — Apple translucent nav bar */}
      <header className="header-inner" style={{background:'rgba(242,242,247,0.85)',backdropFilter:'blur(20px) saturate(180%)',WebkitBackdropFilter:'blur(20px) saturate(180%)',borderBottom:'0.5px solid rgba(60,60,67,0.29)',padding:'0 20px',height:52,display:'flex',alignItems:'center',justifyContent:'space-between',position:'sticky',top:0,zIndex:200,flexShrink:0}}>
        <div style={{display:'flex',alignItems:'center',gap:2}}>
          <div style={{marginRight:14,display:'flex',alignItems:'center',gap:8}}>
            <div style={{width:28,height:28,borderRadius:10,background:'linear-gradient(135deg,#007AFF,#5856D6)',display:'flex',alignItems:'center',justifyContent:'center',boxShadow:'0 2px 8px rgba(0,122,255,0.3)',overflow:'hidden'}}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/ape/ape-x-icon-logo.png" alt="Ape X" style={{width:'100%',height:'100%',objectFit:'contain'}}/>
            </div>
            <span style={{fontSize:15,fontWeight:700,letterSpacing:'-0.02em',color:'#000'}}>Ape X</span>
          </div>
          <div style={{width:0.5,height:24,background:'rgba(60,60,67,0.29)',marginRight:12}}/>
          {([
            {key:'search',icon:<Search size={15}/>,label:'Search'},
            {key:'board',icon:<Briefcase size={15}/>,label:`Board${jobs.length>0?` (${jobs.length})`:''}`},
            {key:'applied',icon:<CheckSquare size={15}/>,label:`Applied${appliedJobs.length>0?` (${appliedJobs.length})`:''}`},
            {key:'settings',icon:<Settings size={15}/>,label:'Settings'},
          ] as {key:Tab;icon:React.ReactNode;label:string}[]).map(t=>(
            <button key={t.key} onClick={()=>setTab(t.key)} style={{background:tab===t.key?'rgba(0,122,255,0.1)':'none',border:'none',cursor:'pointer',padding:'5px 12px',borderRadius:10,display:'flex',alignItems:'center',gap:5,fontSize:13,fontWeight:tab===t.key?600:500,color:tab===t.key?'#007AFF':'rgba(60,60,67,0.7)',transition:'all 0.15s',whiteSpace:'nowrap'}}>
              {t.icon}<span className="nav-label">{t.label}</span>
            </button>
          ))}
        </div>
        <div style={{display:'flex',gap:6,alignItems:'center'}}>
          <button onClick={()=>setShowHowTo(!showHowTo)} style={{display:'flex',alignItems:'center',gap:4,background:'rgba(120,120,128,0.1)',color:'rgba(60,60,67,0.8)',border:'none',borderRadius:10,padding:'6px 12px',fontSize:12,fontWeight:600,cursor:'pointer'}}>
            <HelpCircle size={13}/><span className="nav-label">Help</span>
          </button>
          <button onClick={()=>setShowReset(true)} style={{display:'flex',alignItems:'center',gap:4,background:'rgba(255,59,48,0.08)',color:'#FF3B30',border:'none',borderRadius:10,padding:'6px 12px',fontSize:12,fontWeight:600,cursor:'pointer'}}>
            <RotateCcw size={12}/><span className="nav-label">Reset</span>
          </button>
        </div>
      </header>

      {/* MAIN CONTENT */}
      <div style={{flex:1}}>

        {/* SEARCH TAB */}
        {tab==='search'&&(
          <main className="main-pad" style={{maxWidth:680,margin:'0 auto',padding:'32px 20px 60px'}}>
            <div style={{marginBottom:28}}>
              <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',gap:16,flexWrap:'wrap',marginBottom:6}}>
                <div>
                  <h1 style={{fontSize:28,fontWeight:700,letterSpacing:'-0.03em',marginBottom:6,color:'#000'}}>Find Your Next Role</h1>
                  <p style={{fontSize:14,color:'rgba(60,60,67,0.6)',lineHeight:1.6}}>Upload your resume and cover letter, then run a live two-pass verified search.</p>
                </div>
                <button onClick={()=>setShowWizard(true)} style={{display:'flex',alignItems:'center',gap:6,background:'rgba(0,122,255,0.1)',color:'#007AFF',border:'none',borderRadius:50,padding:'10px 16px',fontSize:13,fontWeight:600,cursor:'pointer',whiteSpace:'nowrap',flexShrink:0}}>
                  <Wand2 size={14}/>Setup Wizard
                </button>
              </div>
            </div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(220px,1fr))',gap:14,marginBottom:26}}>
              <UploadCard type="resume" meta={resumeMeta} onUpload={f=>handleUpload(f,'resume')}/>
              <UploadCard type="cover" meta={coverMeta} onUpload={f=>handleUpload(f,'cover')}/>
            </div>
            {searchError&&<div style={{background:'rgba(255,59,48,0.08)',color:'#D70015',padding:'12px 14px',borderRadius:12,marginBottom:18,fontSize:13,display:'flex',gap:8,alignItems:'center',border:'0.5px solid rgba(255,59,48,0.2)'}}><AlertTriangle size={14}/>{searchError}</div>}

            {/* Hard block — missing API keys */}
            {(!anthropicKey||!serperKey)&&(
              <div style={{background:'rgba(255,149,0,0.08)',border:'0.5px solid rgba(255,149,0,0.3)',borderRadius:12,padding:'12px 16px',marginBottom:16,fontSize:13,color:'#B56000',display:'flex',alignItems:'flex-start',gap:10}}>
                <AlertTriangle size={15} color="#007AFF" style={{flexShrink:0,marginTop:1}}/>
                <div>
                  <strong>API keys required to search.</strong> Missing:{' '}
                  {!anthropicKey&&<span>Anthropic key</span>}
                  {!anthropicKey&&!serperKey&&<span> · </span>}
                  {!serperKey&&<span>Serper key</span>}
                  {' — '}
                  <button onClick={()=>setTab('settings')} style={{background:'none',border:'none',cursor:'pointer',color:'#007AFF',fontWeight:700,fontSize:13,padding:0,textDecoration:'underline'}}>Go to Settings</button>
                </div>
              </div>
            )}

            {/* Soft warn — missing titles */}
            {anthropicKey&&serperKey&&profile.targetTitles.length===0&&(
              <div style={{background:'rgba(255,204,0,0.1)',border:'0.5px solid rgba(255,204,0,0.35)',borderRadius:10,padding:'10px 14px',marginBottom:14,fontSize:12,color:'#7A5500',display:'flex',alignItems:'center',gap:8}}>
                <AlertTriangle size={13} color="#FF9500"/>
                No job titles configured — search may return broad results.{' '}
                <button onClick={()=>setShowWizard(true)} style={{background:'none',border:'none',cursor:'pointer',color:'#FF9500',fontWeight:700,fontSize:12,padding:0,textDecoration:'underline'}}>Run Setup Wizard</button>
              </div>
            )}

            <div style={{display:'flex',gap:10,alignItems:'center',flexWrap:'wrap'}}>
              <button onClick={runSearch} disabled={!anthropicKey||!serperKey} style={{display:'flex',alignItems:'center',gap:7,background:(!anthropicKey||!serperKey)?'#C7C7CC':'#007AFF',color:'#fff',border:'none',borderRadius:50,padding:'12px 26px',fontSize:14,fontWeight:600,cursor:(!anthropicKey||!serperKey)?'not-allowed':'pointer',letterSpacing:'-0.01em'}}>
                <Search size={16}/>Run Job Search
              </button>
              {specialInstructions&&<span style={{fontSize:11,background:'rgba(255,149,0,0.12)',color:'#B56000',padding:'3px 10px',borderRadius:50,fontWeight:600}}>Special active</span>}
              <button onClick={()=>setShowSpecial(true)} style={{display:'flex',alignItems:'center',gap:5,background:'rgba(120,120,128,0.1)',border:'none',borderRadius:50,padding:'10px 16px',fontSize:13,fontWeight:600,cursor:'pointer',color:'#000'}}>
                <Sparkles size={13}/>Special Instructions
              </button>
            </div>
            <p style={{fontSize:12,color:'rgba(60,60,67,0.45)',marginTop:10,letterSpacing:'-0.01em'}}>~5–6 min · two-pass verified · edit instructions in Settings</p>
            <button className="mobile-only" onClick={()=>setShowMobileFAB(true)} style={{position:'fixed',bottom:80,right:24,zIndex:100,width:52,height:52,borderRadius:'50%',background:'#007AFF',color:'#fff',border:'none',display:'flex',alignItems:'center',justifyContent:'center',boxShadow:'0 4px 20px rgba(0,122,255,0.4)',cursor:'pointer'}}>
              <FileText size={20}/>
            </button>
          </main>
        )}

        {/* BOARD TAB */}
        {tab==='board'&&(
          <main className="main-pad" style={{maxWidth:1100,margin:'0 auto',padding:'26px 16px 60px'}}>
            {jobs.length===0?(
              <div style={{textAlign:'center',padding:'60px 24px'}}>
                <div style={{marginBottom:20}}>
                  <p style={{fontSize:18,fontWeight:700,color:'#000',marginBottom:8,letterSpacing:'-0.02em'}}>Our apes didn&apos;t forage any jobs with these requirements.</p>
                  <p style={{fontSize:14,color:'rgba(60,60,67,0.6)',lineHeight:1.7,marginBottom:20}}>Send them out again by adjusting your settings.</p>
                  <button onClick={()=>setShowWizard(true)} style={{padding:'11px 24px',background:'#007AFF',color:'#fff',border:'none',borderRadius:50,cursor:'pointer',fontWeight:600,fontSize:14,marginBottom:24}}>Run Search Wizard</button>
                </div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/ape/ape-x-full-logo.png" alt="Ape X" style={{width:'100%',maxWidth:200,height:'auto',objectFit:'contain'}}/>
              </div>
            ):(
              <>
                <div style={{display:'flex',justifyContent:'flex-end',marginBottom:10}}>
                  <button onClick={()=>setShowHistory(true)} style={{display:'flex',alignItems:'center',gap:6,padding:'8px 14px',background:'rgba(120,120,128,0.12)',color:'#000',border:'none',borderRadius:50,cursor:'pointer',fontWeight:600,fontSize:12}}>
                    <Clock size={13}/>Saved Searches ({searchHistory.length}/5)
                  </button>
                </div>
                <div style={{background:'rgba(255,255,255,0.8)',backdropFilter:'blur(12px)',WebkitBackdropFilter:'blur(12px)',border:'0.5px solid rgba(60,60,67,0.18)',padding:'10px 14px',borderRadius:12,marginBottom:22,display:'flex',gap:6,flexWrap:'wrap',alignItems:'center'}}>
                  <Filter size={12} style={{color:'rgba(60,60,67,0.6)',marginRight:2}}/>
                  <span style={{fontSize:11,color:'rgba(60,60,67,0.6)',fontWeight:600,marginRight:4}}>Location:</span>
                  {([['false','All'],['true','Remote'],['notremote','Not Remote']] as [string,string][]).map(([val,label])=>(
                    <button key={val} onClick={()=>setFilterRemote(val==='false'?false:val==='true'?true:'notremote')} style={{background:String(filterRemote)===val?'#007AFF':'rgba(120,120,128,0.1)',color:String(filterRemote)===val?'#fff':'rgba(60,60,67,0.7)',border:'none',borderRadius:50,padding:'5px 12px',fontSize:12,fontWeight:500,cursor:'pointer'}}>{label}</button>
                  ))}
                  <div style={{width:1,height:18,background:'rgba(60,60,67,0.2)',margin:'0 2px'}}/>
                  <SortDesc size={12} style={{color:'rgba(60,60,67,0.6)'}}/>
                  <span style={{fontSize:11,color:'rgba(60,60,67,0.6)',fontWeight:600,marginRight:2}}>Sort:</span>
                  {([['rating','Best Fit'],['salary','Salary ↓'],['salaryAsc','Salary ↑'],['recent','Recent']] as [string,string][]).map(([val,label])=>(
                    <button key={val} onClick={()=>setSortBy(val as 'salary'|'rating')} style={{background:sortBy===val?'#007AFF':'rgba(120,120,128,0.1)',color:sortBy===val?'#fff':'rgba(60,60,67,0.7)',border:'none',borderRadius:50,padding:'5px 12px',fontSize:12,fontWeight:500,cursor:'pointer'}}>{label}</button>
                  ))}
                  <div style={{marginLeft:'auto'}}>
                    <button onClick={()=>setShowClearBoard(true)} style={{display:'flex',alignItems:'center',gap:4,padding:'5px 12px',border:'none',borderRadius:50,background:'rgba(255,59,48,0.08)',cursor:'pointer',fontSize:12,color:'#FF3B30'}}><Trash2 size={11}/>Clear</button>
                  </div>
                </div>
                {displayJobs.length===0&&jobs.length>0?(
                  <div style={{textAlign:'center',padding:'40px 24px',color:'rgba(60,60,67,0.6)'}}>
                    <p style={{fontSize:14}}>No jobs match this filter.</p>
                  </div>
                ):(
                  categoryGroups.map(group=>(
                    <section key={group.cat} style={{marginBottom:32}}>
                      <div style={{display:'flex',alignItems:'baseline',gap:10,marginBottom:12,paddingBottom:8,borderBottom:'0.5px solid rgba(60,60,67,0.2)'}}>
                        <h2 style={{fontSize:18,fontWeight:700,letterSpacing:'-0.02em',color:'#000'}}>{group.cat}</h2>
                        <span style={{fontSize:12,color:'rgba(60,60,67,0.5)',fontWeight:500}}>{group.list.length} {group.list.length===1?'role':'roles'}</span>
                      </div>
                      <div style={{display:'grid',gap:10}}>
                        {group.list.map(j=><JobCard key={j.id} job={j} applied={isJobApplied(j.id)} generatingType={generatingJobs[j.id]||null} onGenerate={(job,type)=>setGenerateModal({job,type})} onReturnToExcluded={returnToExcluded}/>)}
                      </div>
                    </section>
                  ))
                )}
                {excludedJobs.length>0&&(
                  <div style={{marginTop:36,padding:18,background:'rgba(255,59,48,0.04)',border:'0.5px solid rgba(255,59,48,0.2)',borderRadius:16}}>
                    <h3 style={{fontSize:15,fontWeight:700,marginBottom:12,color:'#D70015',display:'flex',alignItems:'center',gap:7,letterSpacing:'-0.01em'}}>
                      <AlertTriangle size={16} fill="#007AFF" color="#007AFF"/>Jobs Excluded After Audit ({excludedJobs.length})
                    </h3>
                    <div style={{overflowX:'auto'}}>
                      <table style={{width:'100%',fontSize:12,borderCollapse:'collapse',minWidth:480}}>
                        <thead><tr style={{textAlign:'left',borderBottom:'0.5px solid rgba(60,60,67,0.2)'}}>
                          {['Company','Role','Layer Failed','Reason',''].map(h=><th key={h} style={{padding:'5px 10px 5px 0',color:'rgba(60,60,67,0.6)',fontWeight:600}}>{h}</th>)}
                        </tr></thead>
                        <tbody>
                          {excludedJobs.map(j=>(
                            <tr key={j.id} style={{borderBottom:'0.5px solid #E5E5EA'}}>
                              <td style={{padding:'7px 10px 7px 0',fontWeight:600}}>{j.company}</td>
                              <td style={{padding:'7px 10px'}}>{j.title}</td>
                              <td style={{padding:'7px 10px'}}>{j.layerFailed}</td>
                              <td style={{padding:'7px 10px',color:'#007AFF'}}>{j.reason}</td>
                              <td style={{padding:'7px 0'}}>
                                <button onClick={()=>openAddToBoard(j)} style={{display:'flex',alignItems:'center',gap:4,padding:'5px 10px',background:'#000000',color:'#fff',border:'none',borderRadius:10,cursor:'pointer',fontSize:11,fontWeight:700,whiteSpace:'nowrap'}}>
                                  <PlusCircle size={11}/>Add to Board
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </>
            )}
          </main>
        )}

        {/* APPLIED TAB */}
        {tab==='applied'&&(
          <main className="main-pad" style={{maxWidth:840,margin:'0 auto',padding:'40px 16px 60px'}}>
            <div style={{display:'flex',alignItems:'flex-end',justifyContent:'space-between',marginBottom:26,gap:14,flexWrap:'wrap'}}>
              <div>
                <div style={{fontSize:11,letterSpacing:'0.06em',textTransform:'uppercase',color:'rgba(60,60,67,0.5)',fontWeight:600,marginBottom:6}}>Application Tracker</div>
                <h1 style={{fontSize:26,fontWeight:700,letterSpacing:'-0.03em',color:'#000'}}>Applied Jobs</h1>
              </div>
              {appliedJobs.length>0&&<button onClick={()=>{if(confirm('Clear all applied jobs?')){clearAppliedJobs();setAppliedJobs([]);}}} style={{display:'flex',alignItems:'center',gap:5,padding:'7px 14px',background:'rgba(255,59,48,0.08)',color:'#FF3B30',border:'none',borderRadius:50,cursor:'pointer',fontSize:13,fontWeight:600}}><Trash2 size={13}/>Clear All</button>}
            </div>
            {appliedJobs.length===0?(
              <div style={{textAlign:'center',padding:'60px 24px',color:'rgba(60,60,67,0.6)'}}>
                <CheckSquare size={44} style={{opacity:0.3,marginBottom:14}}/>
                <h3 style={{fontSize:20,fontWeight:700,color:'#000',marginBottom:8,letterSpacing:'-0.02em'}}>No applications yet</h3>
                <p style={{fontSize:14,lineHeight:1.7,maxWidth:340,margin:'0 auto'}}>Generating any document marks a job as Applied here automatically.</p>
              </div>
            ):(
              <div style={{display:'flex',flexDirection:'column',gap:10}}>
                {appliedJobs.map(job=>(
                  <div key={job.id} style={{background:'#fff',border:'0.5px solid rgba(60,60,67,0.15)',borderRadius:16,padding:'16px 18px',boxShadow:'0 1px 4px rgba(0,0,0,0.06)'}}>
                    <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:12,flexWrap:'wrap'}}>
                      <div style={{flex:1,minWidth:180}}>
                        <div style={{fontSize:11,letterSpacing:'0.04em',textTransform:'uppercase',fontWeight:600,color:'rgba(60,60,67,0.5)',marginBottom:3}}>{job.company}</div>
                        <div style={{fontSize:16,fontWeight:700,letterSpacing:'-0.01em',marginBottom:9,color:'#000'}}>{job.title}</div>
                        <div style={{display:'flex',flexWrap:'wrap',gap:5,alignItems:'center',marginBottom:9}}>
                          {(job.statusHistory||[]).map((s,i)=>(
                            <div key={i} style={{display:'flex',alignItems:'center',gap:4}}>
                              {i>0&&<ArrowRight size={9} color="rgba(60,60,67,0.2)"/>}
                              <span style={{background:statusBg(s.status),color:statusColor(s.status),fontSize:10,fontWeight:700,letterSpacing:'0.03em',textTransform:'uppercase',padding:'3px 8px',borderRadius:50}}>{s.status}</span>
                              <span style={{fontSize:10,color:'rgba(60,60,67,0.6)'}}>{new Date(s.date).toLocaleDateString('en-US',{month:'short',day:'numeric'})}{s.note&&` · ${s.note}`}</span>
                            </div>
                          ))}
                        </div>
                        <div style={{display:'flex',gap:5,flexWrap:'wrap'}}>
                          {job.resumeGenerated&&<span style={{fontSize:10,background:'rgba(0,122,255,0.1)',color:'#007AFF',padding:'2px 7px',borderRadius:10,fontWeight:700,display:'flex',alignItems:'center',gap:3}}><FileText size={10} fill="#007AFF"/>Resume</span>}
                          {job.coverLetterGenerated&&<span style={{fontSize:10,background:'rgba(175,82,222,0.1)',color:'#7A1AAA',padding:'2px 7px',borderRadius:10,fontWeight:700,display:'flex',alignItems:'center',gap:3}}><Mail size={10} fill="#7A1AAA"/>Cover Letter</span>}
                        </div>
                      </div>
                      <div style={{display:'flex',flexDirection:'column',gap:7,alignItems:'flex-end'}}>
                        <div style={{fontSize:11,color:'rgba(60,60,67,0.6)',display:'flex',alignItems:'center',gap:4}}><Clock size={11}/>{new Date(job.appliedAt).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}</div>
                        <div style={{display:'flex',gap:5,flexWrap:'wrap'}}>
                          <button onClick={()=>setAddStatusModal(job.id)} style={{display:'flex',alignItems:'center',gap:4,padding:'5px 10px',border:'0.5px solid rgba(60,60,67,0.2)',borderRadius:10,background:'transparent',cursor:'pointer',fontSize:12,fontWeight:600}}><Plus size={11}/>Status</button>
                          {job.applyUrl&&<a href={job.applyUrl} target="_blank" rel="noreferrer" style={{display:'flex',alignItems:'center',padding:'5px 9px',border:'0.5px solid rgba(60,60,67,0.2)',borderRadius:10,fontSize:12,fontWeight:600,textDecoration:'none',color:'#000000'}}><ExternalLink size={12}/></a>}
                          <button onClick={()=>{if(confirm(`Remove ${job.company}?`)){deleteAppliedJob(job.id);setAppliedJobs(getAppliedJobs());}}} style={{display:'flex',alignItems:'center',padding:'5px 9px',border:'0.5px solid rgba(0,122,255,0.12)',borderRadius:10,background:'transparent',cursor:'pointer',color:'#007AFF'}}><Trash2 size={12}/></button>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </main>
        )}

        {/* SETTINGS TAB */}
        {tab==='settings'&&(
          <main className="main-pad" style={{maxWidth:800,margin:'0 auto',padding:'40px 16px 60px'}}>
            <div style={{marginBottom:28}}>
              <div style={{fontSize:11,letterSpacing:'0.06em',textTransform:'uppercase',color:'rgba(60,60,67,0.5)',fontWeight:600,marginBottom:6}}>Configuration</div>
              <h1 style={{fontSize:26,fontWeight:700,letterSpacing:'-0.03em',color:'#000'}}>Settings</h1>
            </div>

            {/* Profile summary */}
            <section style={{background:'#fff',border:'0.5px solid rgba(60,60,67,0.15)',borderRadius:16,padding:22,marginBottom:16,boxShadow:'0 1px 4px rgba(0,0,0,0.05)'}}>
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14,flexWrap:'wrap',gap:10}}>
                <h2 style={{fontSize:17,fontWeight:700,letterSpacing:'-0.01em',display:'flex',alignItems:'center',gap:7}}><User size={17}/>Candidate Profile</h2>
                <button onClick={()=>setShowWizard(true)} style={{display:'flex',alignItems:'center',gap:5,padding:'7px 14px',background:'rgba(0,122,255,0.1)',color:'#007AFF',border:'none',borderRadius:50,cursor:'pointer',fontWeight:600,fontSize:13}}><Wand2 size={13}/>Re-run Wizard</button>
              </div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(200px,1fr))',gap:10,fontSize:13,color:'#000'}}>
                <div><span style={{fontSize:11,fontWeight:600,textTransform:'uppercase',letterSpacing:'0.04em',color:'rgba(60,60,67,0.5)',display:'block',marginBottom:3}}>Name</span>{profile.name||'—'}</div>
                <div><span style={{fontSize:11,fontWeight:600,textTransform:'uppercase',letterSpacing:'0.04em',color:'rgba(60,60,67,0.5)',display:'block',marginBottom:3}}>Most Recent Role</span>{profile.mostRecentRole||'—'} at {profile.mostRecentEmployer||'—'}</div>
                <div><span style={{fontSize:11,fontWeight:600,textTransform:'uppercase',letterSpacing:'0.04em',color:'rgba(60,60,67,0.5)',display:'block',marginBottom:3}}>Salary Target</span>{fmtSalary(profile.salaryMin)} – {fmtSalary(profile.salaryMax)}</div>
                <div><span style={{fontSize:11,fontWeight:600,textTransform:'uppercase',letterSpacing:'0.04em',color:'rgba(60,60,67,0.5)',display:'block',marginBottom:3}}>Work Preference</span>{profile.workTypes.join(', ')}</div>
                <div><span style={{fontSize:11,fontWeight:600,textTransform:'uppercase',letterSpacing:'0.04em',color:'rgba(60,60,67,0.5)',display:'block',marginBottom:3}}>Links</span>
                  <div style={{display:'flex',flexWrap:'wrap',gap:4}}>
                    {profile.linkedinUrl&&<a href={`https://${profile.linkedinUrl}`} target="_blank" rel="noreferrer" style={{display:'flex',alignItems:'center',gap:3,fontSize:11,color:'#007AFF',textDecoration:'none'}}><Link size={10}/>LinkedIn</a>}
                    {profile.portfolioUrl&&<a href={`https://${profile.portfolioUrl}`} target="_blank" rel="noreferrer" style={{display:'flex',alignItems:'center',gap:3,fontSize:11,color:'#007AFF',textDecoration:'none'}}><Link size={10}/>Portfolio</a>}
                    {(profile.additionalLinks||[]).map(l=><a key={l.title} href={l.url} target="_blank" rel="noreferrer" style={{display:'flex',alignItems:'center',gap:3,fontSize:11,color:'#007AFF',textDecoration:'none'}}><Link size={10}/>{l.title}</a>)}
                  </div>
                </div>
              </div>
            </section>

            {/* AI Provider */}
            <section style={{background:'#fff',border:'0.5px solid rgba(60,60,67,0.15)',borderRadius:16,padding:22,marginBottom:16,boxShadow:'0 1px 4px rgba(0,0,0,0.05)'}}>
              <h2 style={{fontSize:17,fontWeight:700,letterSpacing:'-0.01em',marginBottom:5,display:'flex',alignItems:'center',gap:7}}><Sparkles size={17}/>AI Provider</h2>
              <p style={{fontSize:13,color:'rgba(60,60,67,0.6)',marginBottom:16,lineHeight:1.7}}>
                Choose which AI service to use. You can switch anytime — saved keys for each provider auto-fill.
              </p>
              <div className="provider-toggle" style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:14}}>
                <button
                  onClick={()=>{setAiProvider('claude');setAIProvider('claude');}}
                  style={{
                    padding:14,
                    background:aiProvider==='claude'?'rgba(0,122,255,0.1)':'#F2F2F7',
                    border:aiProvider==='claude'?'2px solid #007AFF':'2px solid transparent',
                    borderRadius:12,
                    cursor:'pointer',
                    textAlign:'left',
                    minHeight:44, // ≥44px touch target
                  }}
                >
                  <div style={{fontSize:14,fontWeight:700,color:'#000',marginBottom:4}}>Claude (Anthropic)</div>
                  <div style={{fontSize:12,color:'rgba(60,60,67,0.7)'}}>
                    {getApiKey('claude')?'✓ Key saved':'No key saved'}
                  </div>
                </button>
                <button
                  onClick={()=>{setAiProvider('gemini');setAIProvider('gemini');}}
                  style={{
                    padding:14,
                    background:aiProvider==='gemini'?'rgba(0,122,255,0.1)':'#F2F2F7',
                    border:aiProvider==='gemini'?'2px solid #007AFF':'2px solid transparent',
                    borderRadius:12,
                    cursor:'pointer',
                    textAlign:'left',
                    minHeight:44,
                  }}
                >
                  <div style={{fontSize:14,fontWeight:700,color:'#000',marginBottom:4}}>Gemini (Google)</div>
                  <div style={{fontSize:12,color:'rgba(60,60,67,0.7)'}}>
                    {getApiKey('gemini')?'✓ Key saved · Free tier available':'Free tier available'}
                  </div>
                </button>
              </div>
              {getApiKey(aiProvider) ? (
                <div style={{padding:12,background:'rgba(26,122,60,0.08)',borderRadius:10,fontSize:12,color:'#1A7A3C',lineHeight:1.6}}>
                  ✓ Using saved {getProviderName(aiProvider)} key. Edit below to change.
                </div>
              ) : (
                <div style={{padding:12,background:'rgba(255,149,0,0.08)',borderRadius:10,fontSize:12,color:'#B25F00',lineHeight:1.6}}>
                  ⚠ No {getProviderName(aiProvider)} key saved yet. Enter one below.
                </div>
              )}
            </section>

            {/* API Keys */}
            <section style={{background:'#fff',border:'0.5px solid rgba(60,60,67,0.15)',borderRadius:16,padding:22,marginBottom:16,boxShadow:'0 1px 4px rgba(0,0,0,0.05)'}}>
              <h2 style={{fontSize:17,fontWeight:700,letterSpacing:'-0.01em',marginBottom:5,display:'flex',alignItems:'center',gap:7}}><Settings size={17}/>API Keys</h2>
              <p style={{fontSize:13,color:'rgba(60,60,67,0.6)',marginBottom:16,lineHeight:1.7}}>
                Stored in browser. Update keys when switching providers.&nbsp;
                {aiProvider==='claude'
                  ?<><a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer" style={{color:'#007AFF'}}>Get Claude key ↗</a></>
                  :<><a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" style={{color:'#007AFF'}}>Get Gemini key ↗</a></>
                }&nbsp;·&nbsp;
                <a href="https://serper.dev/api-key" target="_blank" rel="noreferrer" style={{color:'#007AFF'}}>Get Serper key ↗</a>
              </p>
              <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(200px,1fr))',gap:12,marginBottom:14}}>
                <div>
                  <div style={{fontSize:11,fontWeight:600,letterSpacing:'0.04em',textTransform:'uppercase',color:'rgba(60,60,67,0.5)',marginBottom:5}}>{getProviderName(aiProvider)} API Key</div>
                  <input type="password" value={anthropicKey} onChange={e=>setAnthropicKey(e.target.value)} placeholder={getAPIKeyPlaceholder(aiProvider)} style={{width:'100%'}}/>
                </div>
                <div>
                  <div style={{fontSize:11,fontWeight:600,letterSpacing:'0.04em',textTransform:'uppercase',color:'rgba(60,60,67,0.5)',marginBottom:5}}>Serper API Key</div>
                  <input type="password" value={serperKey} onChange={e=>setSerperKey(e.target.value)} placeholder="Serper key..." style={{width:'100%'}}/>
                </div>
              </div>
              <button onClick={()=>{setApiKey(aiProvider,anthropicKey);setLocalSerperKey(serperKey);setKeysSaved(true);setTimeout(()=>setKeysSaved(false),2000);}} style={{display:'flex',alignItems:'center',gap:5,padding:'8px 18px',background:'#007AFF',color:'#fff',border:'none',borderRadius:50,cursor:'pointer',fontWeight:600,fontSize:13}}>
                {keysSaved?<><CheckCircle size={13} fill="#fff"/>Saved</>:<><CheckSquare size={13}/>Save Keys</>}
              </button>
            </section>

            {/* Instructions */}
            {([
              {key:'jobSearch' as const,label:'Job Search Instructions',icon:<Search size={16}/>},
              {key:'resume' as const,label:'Resume Generation Instructions',icon:<FileText size={16}/>},
              {key:'coverLetter' as const,label:'Cover Letter Instructions',icon:<Mail size={16}/>},
            ]).map(({key,label,icon})=>{
              const value=key==='jobSearch'?jobSearchInstr:key==='resume'?resumeInstr:coverInstr;
              const setter=key==='jobSearch'?setJobSearchInstr:key==='resume'?setResumeInstr:setCoverInstr;
              return (
                <section key={key} style={{background:'#fff',border:'0.5px solid rgba(60,60,67,0.15)',borderRadius:16,padding:22,marginBottom:16,boxShadow:'0 1px 4px rgba(0,0,0,0.05)'}}>
                  <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:12,flexWrap:'wrap',gap:8}}>
                    <h2 style={{fontSize:16,fontWeight:700,letterSpacing:'-0.01em',display:'flex',alignItems:'center',gap:7}}>{icon}{label}</h2>
                    <div style={{display:'flex',gap:7,flexWrap:'wrap'}}>
                      <button onClick={()=>setResetInstrTarget(key)} style={{display:'flex',alignItems:'center',gap:5,padding:'6px 12px',background:'rgba(255,59,48,0.08)',color:'#FF3B30',border:'none',borderRadius:50,cursor:'pointer',fontSize:12,fontWeight:600}}><RotateCcw size={12}/>Reset</button>
                      <button onClick={()=>copyInstrs(key)} style={{display:'flex',alignItems:'center',gap:5,padding:'6px 12px',border:'none',borderRadius:50,background:'rgba(120,120,128,0.1)',cursor:'pointer',fontSize:12,fontWeight:600}}>
                        {copied===key?<><CheckCircle size={12}/>Copied!</>:<><Copy size={12}/>Copy</>}
                      </button>
                      <button onClick={()=>saveInstrs(key)} style={{display:'flex',alignItems:'center',gap:5,padding:'6px 14px',background:'#007AFF',color:'#fff',border:'none',borderRadius:50,cursor:'pointer',fontSize:12,fontWeight:600}}>
                        {instrSaved===key?<><CheckCircle size={12} fill="#fff"/>Saved</>:<><CheckSquare size={12}/>Save</>}
                      </button>
                    </div>
                  </div>
                  <textarea value={value} onChange={e=>setter(e.target.value)} rows={10}
                    style={{width:'100%',fontFamily:'ui-monospace,monospace',fontSize:12}}/>
                  <p style={{fontSize:11,color:'rgba(60,60,67,0.45)',marginTop:6}}>Save writes to localStorage. "Copy" copies to clipboard for manual repo update.</p>
                </section>
              );
            })}
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:10,marginTop:8}}>
              <button onClick={()=>setShowSaveImport(true)} style={{display:'flex',alignItems:'center',gap:6,padding:'10px 20px',background:'#007AFF',color:'#fff',border:'none',borderRadius:50,cursor:'pointer',fontWeight:600,fontSize:13}}>
                <Upload size={14}/>Save / Import Job Board
              </button>
              <button onClick={()=>{const p=getSavedProfile()||DEFAULT_PROFILE;const js=buildJobSearchInstructions(p);const res=buildResumeInstructions(p);const cv=buildCoverLetterInstructions(p);setJobSearchInstr(js);setResumeInstr(res);setCoverInstr(cv);saveInstructions({jobSearch:js,resume:res,coverLetter:cv});}} style={{display:'flex',alignItems:'center',gap:5,padding:'9px 16px',background:'rgba(255,59,48,0.08)',color:'#FF3B30',border:'none',borderRadius:50,cursor:'pointer',fontSize:13,fontWeight:600}}>
                <RotateCcw size={13}/>Reset Instructions
              </button>
            </div>
          </main>
        )}
      </div>

      {/* STICKY FOOTER */}
      <footer style={{background:'rgba(242,242,247,0.85)',backdropFilter:'blur(20px)',WebkitBackdropFilter:'blur(20px)',borderTop:'0.5px solid rgba(60,60,67,0.18)',color:'rgba(60,60,67,0.5)',textAlign:'center',padding:'10px 20px',fontSize:11,display:'flex',alignItems:'center',justifyContent:'center',gap:6,position:'sticky',bottom:0,zIndex:100,flexShrink:0,flexWrap:'wrap'}}>
        <Copyright size={11}/>
        <span>Ape X Job Hunt</span>
        <span>·</span>
        <button onClick={()=>setShowTerms(true)} style={{background:'none',border:'none',cursor:'pointer',color:'rgba(60,60,67,0.6)',fontSize:11,padding:0,textDecoration:'underline'}}>Terms &amp; Conditions</button>
      </footer>
    </div>
  );
}
