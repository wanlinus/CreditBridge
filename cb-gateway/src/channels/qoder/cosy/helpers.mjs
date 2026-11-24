function BDn(A,e){let t=e(1*A.length,1)>>>0;return nYe().set(A,t/1),Mg=A.length,t}

function Kk(A){let e=eB(A);return xel(A),e}

function So(){return(null===Cxe||!0===Cxe.buffer.detached||void 0===Cxe.buffer.detached&&Cxe.buffer!==en.memory.buffer)&&(Cxe=new DataView(en.memory.buffer)),Cxe}

function YD(A,e){return kel(A>>>=0,e)}

function kh(A,e,t){if(void 0===t){let t=MmA.encode(A),i=e(t.length,1)>>>0;return nYe().subarray(i,i+t.length).set(t),Mg=t.length,i}let i=A.length,r=e(i,1)>>>0,n=nYe(),o=0;for(;o<i;o++){let e=A.charCodeAt(o);if(e>127)break;n[r+o]=e}if(o!==i){0!==o&&(A=A.slice(o)),r=t(r,i,i=o+3*A.length,1)>>>0;let e=nYe().subarray(r+o,r+i);o+=MmA.encodeInto(A,e).written,r=t(r,i,o,1)>>>0}return Mg=o,r}

function yAe(A){return null==A}

function tYe(A,e){return A>>>=0,nYe().subarray(A/1,A/1+e)}

function nYe(){return(null===TmA||0===TmA.byteLength)&&(TmA=new Uint8Array(en.memory.buffer)),TmA}

function kel(A,e){return(IDn+=e)>=Pel&&((HAt=new TextDecoder("utf-8",{ignoreBOM:!0,fatal:!0})).decode(),IDn=e),HAt.decode(nYe().subarray(A,A+e))}

function eB(A){return DAe[A]}

function xel(A){A<1028||(DAe[A]=bmA,bmA=A)}

function Mw(A){bmA===DAe.length&&DAe.push(DAe.length+1);let e=bmA;return bmA=DAe[e],DAe[e]=A,e}

function eB(A){return DAe[A]}

function RmA(A,e){try{return A.apply(this,e)}catch(A){en.__wbindgen_export(Mw(A))}}