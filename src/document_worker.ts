import {extractDocxText,extractHtmlText} from './document_text.ts';
const scope=globalThis as unknown as {onmessage:(event:MessageEvent)=>void;postMessage:(v:unknown)=>void};
scope.onmessage=async(event:MessageEvent)=>{
  try {
    const bytes=new Uint8Array(event.data.bytes);
    const result=event.data.format==='docx'?await extractDocxText(bytes):await extractHtmlText(bytes);
    scope.postMessage({result});
  } catch { scope.postMessage({error:'processor_failed'}); }
};
