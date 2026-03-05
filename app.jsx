import React, { useState, useEffect, useRef, useCallback } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, setDoc, onSnapshot, updateDoc, arrayUnion, collection, deleteDoc } from 'firebase/firestore';
import { UploadCloud, File, Link as LinkIcon, Copy, CheckCircle2, AlertCircle, Loader2, ArrowDownCircle, Info, ShieldCheck, Sparkles, Image as ImageIcon } from 'lucide-react';

// --- Firebase Initialization ---
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';

// Collection path mandated by rules
const ROOMS_COLLECTION = 'rooms';
const getRoomsCollection = () => collection(db, 'artifacts', appId, 'public', 'data', ROOMS_COLLECTION);

// --- WebRTC Configuration ---
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// --- Gemini API Configuration ---
const GEMINI_API_KEY = ""; // Provided by environment
const callGemini = async (prompt, mimeType = null, base64Data = null) => {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${GEMINI_API_KEY}`;
  
  const parts = [{ text: prompt }];
  if (mimeType && base64Data) {
    parts.push({
      inlineData: { mimeType, data: base64Data }
    });
  }

  const payload = {
    contents: [{ role: "user", parts }],
    systemInstruction: { parts: [{ text: "You are a helpful file analysis assistant. Keep your summaries very brief, professional, and limited to 1-2 sentences. Your goal is to tell the receiver what this file is." }] }
  };

  const attempt = async (retries) => {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error(`HTTP error ${res.status}`);
      const data = await res.json();
      return data.candidates[0].content.parts[0].text;
    } catch (err) {
      if (retries > 0) {
        await new Promise(r => setTimeout(r, (5 - retries) * 1000));
        return attempt(retries - 1);
      }
      throw err;
    }
  };
  return attempt(3);
};

// --- Helper Utilities ---
const generateRoomId = () => Math.random().toString(36).substring(2, 8).toUpperCase();
const formatBytes = (bytes, decimals = 2) => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
};

export default function App() {
  const [user, setUser] = useState(null);
  const [appState, setAppState] = useState('initializing'); // initializing, sender, receiver
  const [roomId, setRoomId] = useState(null);

  useEffect(() => {
    const initAuth = async () => {
      try {
        if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
          await signInWithCustomToken(auth, __initial_auth_token);
        } else {
          await signInAnonymously(auth);
        }
      } catch (err) {
        console.error("Auth error:", err);
      }
    };
    initAuth();

    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      if (u) {
        const urlParams = new URLSearchParams(window.location.search);
        const roomFromUrl = urlParams.get('room');
        if (roomFromUrl) {
          setRoomId(roomFromUrl);
          setAppState('receiver');
        } else {
          setAppState('sender');
        }
      }
    });

    return () => unsubscribe();
  }, []);

  if (appState === 'initializing' || !user) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center font-sans">
        <div className="flex flex-col items-center text-slate-500">
          <Loader2 className="w-10 h-10 animate-spin mb-4 text-indigo-500" />
          <p>Initializing Sid Share...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-100 flex flex-col font-sans text-slate-800">
      <header className="p-6 text-center">
        <h1 className="text-3xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-indigo-600 to-blue-600 flex items-center justify-center gap-2">
          <UploadCloud className="w-8 h-8 text-indigo-600" />
          Sid Share
        </h1>
        <p className="text-sm text-slate-500 mt-2 font-medium">Lightning-fast, direct peer-to-peer file sharing</p>
      </header>

      <main className="flex-1 flex items-start justify-center p-4 sm:p-6">
        {appState === 'sender' ? <SenderView user={user} /> : <ReceiverView user={user} roomId={roomId} />}
      </main>

      <footer className="p-6 text-center text-xs text-slate-400">
        <p className="flex items-center justify-center gap-1">
          <ShieldCheck className="w-4 h-4" /> Files are sent directly between devices. Nothing is stored on our servers.
        </p>
      </footer>
    </div>
  );
}

// ==========================================
// SENDER VIEW
// ==========================================
function SenderView({ user }) {
  const [file, setFile] = useState(null);
  const [roomId, setRoomId] = useState('');
  const [status, setStatus] = useState('idle'); 
  const [progress, setProgress] = useState(0);
  const [speed, setSpeed] = useState(0);
  const [copied, setCopied] = useState(false);
  
  // AI Preview States
  const [isGeneratingAi, setIsGeneratingAi] = useState(false);
  const [aiSummaryLocal, setAiSummaryLocal] = useState('');
  const [aiError, setAiError] = useState('');

  const pcRef = useRef(null);
  const dcRef = useRef(null);
  const processedCandidates = useRef(new Set());
  const bytesSentRef = useRef(0);
  const lastTimeRef = useRef(Date.now());
  const lastBytesRef = useRef(0);
  const speedIntervalRef = useRef(null);

  const onDragOver = (e) => e.preventDefault();
  const onDrop = (e) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFileSelect(e.dataTransfer.files[0]);
    }
  };

  const handleFileSelect = (selectedFile) => {
    if (status !== 'idle') return;
    setFile(selectedFile);
    setAiSummaryLocal('');
    setAiError('');
    startWebRTC(selectedFile);
  };

  const startWebRTC = async (selectedFile) => {
    setStatus('waiting');
    const newRoomId = generateRoomId();
    setRoomId(newRoomId);
    
    const pc = new RTCPeerConnection(rtcConfig);
    pcRef.current = pc;
    
    const dc = pc.createDataChannel('fileTransfer', { ordered: true });
    dcRef.current = dc;
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = 256 * 1024; 

    dc.onopen = () => {
      setStatus('transferring');
      sendFileData(selectedFile, dc);
      
      speedIntervalRef.current = setInterval(() => {
        const now = Date.now();
        const bytesNow = bytesSentRef.current;
        const timeDiff = (now - lastTimeRef.current) / 1000;
        if (timeDiff > 0) {
          const bytesDiff = bytesNow - lastBytesRef.current;
          setSpeed(bytesDiff / timeDiff);
        }
        lastTimeRef.current = now;
        lastBytesRef.current = bytesNow;
      }, 1000);
    };

    dc.onclose = () => {
      clearInterval(speedIntervalRef.current);
      if (bytesSentRef.current >= selectedFile.size) {
        setStatus('done');
      } else {
        setStatus('error');
      }
    };

    const roomRef = doc(getRoomsCollection(), newRoomId);

    pc.onicecandidate = async (event) => {
      if (event.candidate) {
        await updateDoc(roomRef, { callerCandidates: arrayUnion(event.candidate.toJSON()) });
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
        setStatus('error');
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    await setDoc(roomRef, {
      offer: { type: offer.type, sdp: offer.sdp },
      fileMeta: { name: selectedFile.name, size: selectedFile.size, type: selectedFile.type },
      callerCandidates: [],
      calleeCandidates: [],
      timestamp: Date.now()
    });

    let hasSetRemote = false;
    const unsubscribe = onSnapshot(roomRef, (snapshot) => {
      const data = snapshot.data();
      if (!data) return;

      if (!hasSetRemote && data.answer) {
        const rtcSessionDescription = new RTCSessionDescription(data.answer);
        pc.setRemoteDescription(rtcSessionDescription);
        hasSetRemote = true;
      }

      if (data.calleeCandidates) {
        data.calleeCandidates.forEach(c => {
          const candidateStr = JSON.stringify(c);
          if (!processedCandidates.current.has(candidateStr)) {
            pc.addIceCandidate(new RTCIceCandidate(c)).catch(console.error);
            processedCandidates.current.add(candidateStr);
          }
        });
      }
    });

    return () => unsubscribe();
  };

  const sendFileData = (fileObj, dc) => {
    let offset = 0;
    const chunkSize = 64 * 1024; 
    
    const sendChunk = () => {
      if (offset >= fileObj.size) {
        dc.send(JSON.stringify({ type: 'EOF' }));
        return;
      }
      if (dc.bufferedAmount > dc.bufferedAmountLowThreshold) return;

      const reader = new FileReader();
      reader.onload = (e) => {
        if (dc.readyState !== 'open') return;
        dc.send(e.target.result);
        offset += chunkSize;
        bytesSentRef.current = offset;
        setProgress((offset / fileObj.size) * 100);
        sendChunk();
      };
      
      const slice = fileObj.slice(offset, offset + chunkSize);
      reader.readAsArrayBuffer(slice);
    };

    dc.onbufferedamountlow = sendChunk;
    sendChunk(); 
  };

  const generateAIPreview = async () => {
    if (!file) return;
    setIsGeneratingAi(true);
    setAiError('');

    try {
      const isImage = file.type.startsWith('image/');
      let summaryText = '';

      if (isImage) {
        if (file.size > 4 * 1024 * 1024) throw new Error("Image too large for preview (Max 4MB).");
        
        const base64 = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = (e) => resolve(e.target.result.split(',')[1]);
          reader.readAsDataURL(file);
        });
        
        summaryText = await callGemini(
          "Briefly describe what is in this image so the person receiving it knows what it is.", 
          file.type, 
          base64
        );
      } else {
        const textChunk = await file.slice(0, 10000).text();
        summaryText = await callGemini(`Analyze this snippet from a file named "${file.name}" and tell me what kind of file it is or what it contains:\n\n${textChunk.substring(0, 3000)}`);
      }

      setAiSummaryLocal(summaryText);
      const roomRef = doc(getRoomsCollection(), roomId);
      await updateDoc(roomRef, { 'fileMeta.aiSummary': summaryText });
      
    } catch (err) {
      setAiError(err.message || "Failed to generate AI preview.");
    } finally {
      setIsGeneratingAi(false);
    }
  };

  const copyLink = () => {
    const url = `${window.location.origin}${window.location.pathname}?room=${roomId}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const shareUrl = roomId ? `${window.location.origin}${window.location.pathname}?room=${roomId}` : '';

  const isTextReadable = file && (
    file.type.startsWith('text/') ||
    file.type === 'application/json' ||
    file.name.match(/\.(js|jsx|ts|tsx|py|html|css|md|csv|txt|json)$/i)
  );
  const isImage = file && file.type.startsWith('image/');
  const canPreview = isTextReadable || (isImage && file.size < 4 * 1024 * 1024);

  return (
    <div className="w-full max-w-md bg-white rounded-3xl shadow-xl overflow-hidden border border-slate-100">
      {status === 'idle' && (
        <div 
          className="p-8 flex flex-col items-center justify-center cursor-pointer transition-colors hover:bg-slate-50 border-2 border-dashed border-transparent hover:border-indigo-200"
          onDragOver={onDragOver}
          onDrop={onDrop}
          onClick={() => document.getElementById('file-upload').click()}
        >
          <div className="w-20 h-20 bg-indigo-50 rounded-full flex items-center justify-center mb-6 shadow-inner">
            <UploadCloud className="w-10 h-10 text-indigo-500" />
          </div>
          <h2 className="text-xl font-bold mb-2">Select a file to send</h2>
          <p className="text-slate-500 text-center text-sm mb-6">Drag and drop any file here, or click to browse. Size limits depend on your browser RAM.</p>
          <button className="bg-indigo-600 text-white font-semibold py-3 px-8 rounded-full hover:bg-indigo-700 transition-all shadow-md hover:shadow-lg active:scale-95">
            Select File
          </button>
          <input 
            type="file" 
            id="file-upload" 
            className="hidden" 
            onChange={(e) => {
              if(e.target.files.length > 0) handleFileSelect(e.target.files[0]);
            }} 
          />
        </div>
      )}

      {status === 'waiting' && (
        <div className="p-8 flex flex-col items-center">
          <div className="w-16 h-16 bg-blue-50 rounded-2xl flex items-center justify-center mb-4 text-blue-500">
            <File className="w-8 h-8" />
          </div>
          <h3 className="text-lg font-bold truncate max-w-full text-center">{file?.name}</h3>
          <p className="text-slate-500 text-sm mb-6">{formatBytes(file?.size)}</p>

          {/* AI Features Block */}
          {canPreview && !aiSummaryLocal && (
            <div className="w-full bg-indigo-50/50 p-4 rounded-2xl border border-indigo-100 mb-6 flex flex-col items-center text-center">
              <Sparkles className="w-6 h-6 text-indigo-400 mb-2" />
              <p className="text-sm text-indigo-800 mb-3 font-medium">Add an AI preview so the receiver knows what they are getting!</p>
              <button 
                onClick={generateAIPreview}
                disabled={isGeneratingAi}
                className="bg-indigo-600 text-white text-sm font-semibold py-2 px-5 rounded-full hover:bg-indigo-700 transition-colors shadow-sm disabled:opacity-50 flex items-center gap-2"
              >
                {isGeneratingAi ? <Loader2 className="w-4 h-4 animate-spin" /> : "✨ Generate AI Preview"}
              </button>
              {aiError && <p className="text-xs text-red-500 mt-2">{aiError}</p>}
            </div>
          )}

          {aiSummaryLocal && (
            <div className="w-full bg-gradient-to-br from-indigo-50 to-blue-50 p-4 rounded-2xl border border-indigo-100 mb-6 text-left relative overflow-hidden">
               <Sparkles className="absolute -top-2 -right-2 w-16 h-16 text-indigo-200 opacity-30" />
               <p className="text-xs font-bold text-indigo-600 mb-1 flex items-center gap-1">
                 <Sparkles className="w-3 h-3" /> Preview sent to receiver
               </p>
               <p className="text-sm text-slate-700 leading-relaxed relative z-10">{aiSummaryLocal}</p>
            </div>
          )}

          <div className="w-full bg-slate-50 p-4 rounded-2xl border border-slate-200 flex flex-col items-center gap-4">
            <p className="text-sm font-semibold text-slate-700">Waiting for receiver to join...</p>
            
            <img 
              src={`https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(shareUrl)}&color=4f46e5`} 
              alt="QR Code" 
              className="w-32 h-32 bg-white p-2 rounded-xl shadow-sm border border-slate-200"
            />
            
            <div className="w-full flex items-center gap-2 bg-white p-2 rounded-xl border border-slate-200 mt-2 shadow-sm">
              <LinkIcon className="w-5 h-5 text-slate-400 ml-2" />
              <input 
                type="text" 
                readOnly 
                value={shareUrl} 
                className="flex-1 text-sm bg-transparent outline-none text-slate-600 truncate"
              />
              <button 
                onClick={copyLink}
                className="p-2 bg-indigo-50 text-indigo-600 rounded-lg hover:bg-indigo-100 transition-colors shrink-0"
                title="Copy Link"
              >
                {copied ? <CheckCircle2 className="w-5 h-5" /> : <Copy className="w-5 h-5" />}
              </button>
            </div>
          </div>
          <p className="text-xs text-slate-400 mt-6 flex items-center gap-1">
            <Info className="w-4 h-4"/> Keep this page open until the transfer finishes.
          </p>
        </div>
      )}

      {(status === 'transferring' || status === 'done' || status === 'error') && (
        <TransferUI 
          file={file} 
          status={status} 
          progress={progress} 
          speed={speed} 
          isSender={true}
          onReset={() => window.location.reload()}
        />
      )}
    </div>
  );
}

// ==========================================
// RECEIVER VIEW
// ==========================================
function ReceiverView({ user, roomId }) {
  const [fileMeta, setFileMeta] = useState(null);
  const [status, setStatus] = useState('fetching_meta'); 
  const [progress, setProgress] = useState(0);
  const [speed, setSpeed] = useState(0);

  const pcRef = useRef(null);
  const dcRef = useRef(null);
  const processedCandidates = useRef(new Set());
  const receiveBufferRef = useRef([]);
  const receivedSizeRef = useRef(0);
  
  const lastTimeRef = useRef(Date.now());
  const lastBytesRef = useRef(0);
  const speedIntervalRef = useRef(null);

  useEffect(() => {
    if (!roomId || !user) return;

    const roomRef = doc(getRoomsCollection(), roomId);
    let unsubscribe = null;

    const initReceiver = async () => {
      unsubscribe = onSnapshot(roomRef, (snapshot) => {
        const data = snapshot.data();
        if (!data) {
          if (status !== 'transferring' && status !== 'done') {
            setStatus('invalid');
          }
          return;
        }

        // Always update fileMeta so we catch AI summaries added late
        if (data.fileMeta) {
          setFileMeta(data.fileMeta);
          if (status === 'fetching_meta') setStatus('waiting_accept');
        }

        if (pcRef.current && data.callerCandidates) {
          data.callerCandidates.forEach(c => {
            const candidateStr = JSON.stringify(c);
            if (!processedCandidates.current.has(candidateStr)) {
              pcRef.current.addIceCandidate(new RTCIceCandidate(c)).catch(console.error);
              processedCandidates.current.add(candidateStr);
            }
          });
        }
      });
    };

    initReceiver();
    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [roomId, user, status]);

  const acceptTransfer = async () => {
    setStatus('transferring');
    const roomRef = doc(getRoomsCollection(), roomId);
    
    const pc = new RTCPeerConnection(rtcConfig);
    pcRef.current = pc;

    pc.onicecandidate = async (event) => {
      if (event.candidate) {
        await updateDoc(roomRef, { calleeCandidates: arrayUnion(event.candidate.toJSON()) });
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
        setStatus('error');
      }
    };

    pc.ondatachannel = (event) => {
      const dc = event.channel;
      dcRef.current = dc;
      dc.binaryType = 'arraybuffer';

      speedIntervalRef.current = setInterval(() => {
        const now = Date.now();
        const bytesNow = receivedSizeRef.current;
        const timeDiff = (now - lastTimeRef.current) / 1000;
        if (timeDiff > 0) {
          const bytesDiff = bytesNow - lastBytesRef.current;
          setSpeed(bytesDiff / timeDiff);
        }
        lastTimeRef.current = now;
        lastBytesRef.current = bytesNow;
      }, 1000);

      dc.onmessage = (e) => {
        if (typeof e.data === 'string') {
          try {
            const msg = JSON.parse(e.data);
            if (msg.type === 'EOF') finishTransfer();
          } catch (err) {}
        } else {
          receiveBufferRef.current.push(e.data);
          receivedSizeRef.current += e.data.byteLength;
          setProgress((receivedSizeRef.current / fileMeta.size) * 100);
        }
      };

      dc.onclose = () => clearInterval(speedIntervalRef.current);
    };

    onSnapshot(roomRef, async (snapshot) => {
      const data = snapshot.data();
      if(data && data.offer && pc.signalingState === "stable") {
         await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
         const answer = await pc.createAnswer();
         await pc.setLocalDescription(answer);
         await updateDoc(roomRef, { answer: { type: answer.type, sdp: answer.sdp } });
      }
    });
  };

  const finishTransfer = () => {
    clearInterval(speedIntervalRef.current);
    setStatus('done');
    
    const blob = new Blob(receiveBufferRef.current, { type: fileMeta.type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileMeta.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    receiveBufferRef.current = [];
    deleteDoc(doc(getRoomsCollection(), roomId)).catch(console.error);
  };

  if (status === 'invalid') {
    return (
      <div className="w-full max-w-md bg-white rounded-3xl shadow-xl overflow-hidden p-8 text-center border border-slate-100">
        <AlertCircle className="w-16 h-16 text-red-500 mx-auto mb-4" />
        <h2 className="text-xl font-bold mb-2">Link Invalid or Expired</h2>
        <p className="text-slate-500 mb-6">The sender may have closed their browser or the transfer was cancelled.</p>
        <button 
          onClick={() => window.location.href = window.location.pathname}
          className="bg-slate-100 text-slate-700 font-semibold py-2 px-6 rounded-full hover:bg-slate-200 transition-colors"
        >
          Send a File Instead
        </button>
      </div>
    );
  }

  if (status === 'fetching_meta') {
    return (
      <div className="w-full max-w-md bg-white rounded-3xl shadow-xl overflow-hidden p-12 flex flex-col items-center justify-center border border-slate-100">
        <Loader2 className="w-10 h-10 animate-spin text-indigo-500 mb-4" />
        <p className="text-slate-500 font-medium">Connecting to peer...</p>
      </div>
    );
  }

  if (status === 'waiting_accept') {
    return (
      <div className="w-full max-w-md bg-white rounded-3xl shadow-xl overflow-hidden p-8 border border-slate-100 flex flex-col items-center">
        <div className="w-20 h-20 bg-green-50 rounded-full flex items-center justify-center mb-6 shadow-inner">
          <ArrowDownCircle className="w-10 h-10 text-green-500" />
        </div>
        <h2 className="text-xl font-bold mb-1 text-center">Ready to Receive</h2>
        <h3 className="text-lg font-medium text-slate-700 truncate max-w-full text-center mb-1">{fileMeta?.name}</h3>
        <p className="text-slate-500 text-sm mb-6">{formatBytes(fileMeta?.size)}</p>

        {/* Display the AI Summary to the receiver if the sender generated one */}
        {fileMeta?.aiSummary && (
          <div className="w-full bg-gradient-to-br from-indigo-50 to-blue-50 p-4 rounded-2xl border border-indigo-100 mb-6 text-left relative overflow-hidden">
             <Sparkles className="absolute -top-4 -right-4 w-20 h-20 text-indigo-200 opacity-30" />
             <p className="text-xs font-bold text-indigo-600 mb-2 flex items-center gap-1">
               <Sparkles className="w-3 h-3" /> AI File Preview
             </p>
             <p className="text-sm text-indigo-900 leading-relaxed relative z-10 font-medium">
               "{fileMeta.aiSummary}"
             </p>
          </div>
        )}

        {fileMeta?.size > 500 * 1024 * 1024 && (
          <div className="bg-yellow-50 text-yellow-700 p-3 rounded-xl text-xs mb-6 border border-yellow-200 text-center flex items-center gap-2">
            <AlertCircle className="w-6 h-6 shrink-0"/>
            Warning: Large files might cause memory issues on mobile browsers.
          </div>
        )}

        <button 
          onClick={acceptTransfer}
          className="w-full bg-green-500 text-white font-bold py-4 px-8 rounded-2xl hover:bg-green-600 transition-all shadow-md hover:shadow-lg hover:-translate-y-0.5 active:translate-y-0 text-lg"
        >
          Accept Transfer
        </button>
      </div>
    );
  }

  return (
    <div className="w-full max-w-md bg-white rounded-3xl shadow-xl overflow-hidden border border-slate-100">
      <TransferUI 
        file={fileMeta} 
        status={status} 
        progress={progress} 
        speed={speed} 
        isSender={false}
        onReset={() => window.location.href = window.location.pathname}
      />
    </div>
  );
}

// ==========================================
// SHARED UI COMPONENTS
// ==========================================
function TransferUI({ file, status, progress, speed, isSender, onReset }) {
  
  const getStatusText = () => {
    switch(status) {
      case 'transferring': return isSender ? 'Sending...' : 'Receiving...';
      case 'done': return 'Transfer Complete!';
      case 'error': return 'Transfer Failed';
      default: return 'Connecting...';
    }
  };

  const getStatusColor = () => {
    if (status === 'error') return 'text-red-500';
    if (status === 'done') return 'text-green-500';
    return 'text-indigo-500';
  };

  const safeProgress = Math.min(Math.max(progress, 0), 100);

  return (
    <div className="p-8">
      <div className="flex items-center gap-4 mb-8">
        <div className="w-14 h-14 bg-slate-100 rounded-xl flex items-center justify-center shrink-0">
          <File className="w-7 h-7 text-slate-500" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-lg font-bold text-slate-800 truncate">{file?.name}</h3>
          <p className="text-slate-500 text-sm">{formatBytes(file?.size)}</p>
        </div>
      </div>

      <div className="mb-2 flex justify-between items-end">
        <span className={`font-bold ${getStatusColor()}`}>{getStatusText()}</span>
        <span className="text-2xl font-black text-slate-800">{safeProgress.toFixed(0)}%</span>
      </div>

      <div className="w-full h-4 bg-slate-100 rounded-full overflow-hidden mb-4 shadow-inner">
        <div 
          className={`h-full transition-all duration-300 ${status === 'error' ? 'bg-red-500' : status === 'done' ? 'bg-green-500' : 'bg-indigo-500'}`}
          style={{ width: `${safeProgress}%` }}
        />
      </div>

      <div className="flex justify-between items-center text-sm font-medium">
        {status === 'transferring' ? (
          <span className="text-indigo-600 bg-indigo-50 px-3 py-1 rounded-full">{formatBytes(speed)}/s</span>
        ) : (
          <span className="text-slate-400">
            {status === 'done' ? (isSender ? 'Successfully sent.' : 'Saved to downloads.') : ''}
          </span>
        )}
        <span className="text-slate-500">
          {formatBytes((safeProgress / 100) * (file?.size || 0))} / {formatBytes(file?.size || 0)}
        </span>
      </div>

      {(status === 'done' || status === 'error') && (
        <button 
          onClick={onReset}
          className="mt-8 w-full bg-slate-100 text-slate-700 font-bold py-3 px-6 rounded-xl hover:bg-slate-200 transition-colors"
        >
          {isSender ? 'Send Another File' : 'Share a File'}
        </button>
      )}

      {status === 'error' && (
        <p className="mt-4 text-xs text-red-500 text-center flex items-center justify-center gap-1">
          <AlertCircle className="w-4 h-4" /> Connection lost or peer disconnected.
        </p>
      )}
    </div>
  );
}
