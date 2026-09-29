// 从 APK 的 v2/v3 签名块里抠出签名证书并用 SHA-256 算指纹（无需 Java）
const fs=require('fs'), crypto=require('crypto');
function u64(b,o){ return Number(b.readBigUInt64LE(o)); }
function findEOCD(fd,size){
  const tail=Math.min(65557,size); const buf=Buffer.alloc(tail);
  fs.readSync(fd,buf,0,tail,size-tail);
  for(let i=tail-22;i>=0;i--) if(buf.readUInt32LE(i)===0x06054b50) return {cdOff:buf.readUInt32LE(i+16), at:size-tail+i};
  return null;
}
function extractCerts(file){
  const fd=fs.openSync(file,'r'); const size=fs.statSync(file).size;
  const e=findEOCD(fd,size); if(!e) throw new Error('找不到 EOCD');
  const cd=e.cdOff;
  const tail=Buffer.alloc(24); fs.readSync(fd,tail,0,24,cd-24);
  if(tail.slice(8,24).toString('latin1')!=='APK Sig Block 42') throw new Error('没有 APK Signing Block(可能只有 v1 签名)');
  const blockSize=u64(tail,0);
  const block=Buffer.alloc(blockSize); fs.readSync(fd,block,0,blockSize,cd-8-blockSize);
  fs.closeSync(fd);
  const out={};
  let p=8; const end=block.length-24+16; // 到 magic 之前
  while(p+12<=block.length-24){
    const len=u64(block,p); const id=block.readUInt32LE(p+8); const val=block.slice(p+12,p+8+len);
    if(id===0x7109871a||id===0xf05368c0||id===0x1b93ad61){
      // signers: length-prefixed sequence
      const signersLen=val.readUInt32LE(0); const signers=val.slice(4,4+signersLen);
      const sLen=signers.readUInt32LE(0); const signer=signers.slice(4,4+sLen);
      const sdLen=signer.readUInt32LE(0); const sd=signer.slice(4,4+sdLen);
      let q=0;
      const digLen=sd.readUInt32LE(q); q+=4+digLen;           // 跳过 digests
      const certsLen=sd.readUInt32LE(q); q+=4;                 // certificates
      const certs=sd.slice(q,q+certsLen);
      const cLen=certs.readUInt32LE(0); const cert=certs.slice(4,4+cLen);
      out[id===0x7109871a?'v2':(id===0xf05368c0?'v3':'v3.1')]=cert;
    }
    p+=8+len;
  }
  return out;
}
const fp=c=>crypto.createHash('sha256').update(c).digest('hex').toUpperCase().match(/../g).join(':');
const want='A4:F0:36:29:0C:90:F7:59:FA:44:79:C2:F0:7A:13:64:A1:B8:04:1E:43:64:7A:83:64:C2:BC:2D:C9:E2:F3:5D';
for(const f of process.argv.slice(2)){
  const name=f.split('/').pop();
  try{
    const cs=extractCerts(f);
    for(const k of Object.keys(cs)){
      const s=fp(cs[k]);
      console.log(`${name.padEnd(38)} ${k.padEnd(5)} ${s}  ${s===want?'✅ 与密钥指纹一致':'❌ 不一致'}`);
    }
    if(!Object.keys(cs).length) console.log(`${name.padEnd(38)} 无 v2/v3 签名`);
  }catch(e){ console.log(`${name.padEnd(38)} ✗ ${e.message}`); }
}
