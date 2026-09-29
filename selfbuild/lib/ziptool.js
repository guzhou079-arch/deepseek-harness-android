// ZIP 读 + 改写：未改动的条目**原样搬运压缩数据**，只替换/新增指定条目
const fs=require('fs'), zlib=require('zlib');
const CRC=(()=>{const t=new Int32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c;}return t;})();
const crc32=b=>{let c=-1;for(let i=0;i<b.length;i++)c=CRC[(c^b[i])&0xff]^(c>>>8);return (c^-1)>>>0;};

/** 读中央目录，返回 [{name,method,flags,crc,csize,usize,raw}] */
function readZip(file){
  const fd=fs.openSync(file,'r'), size=fs.statSync(file).size;
  const tailLen=Math.min(size, 65557+20);
  const tail=Buffer.alloc(tailLen); fs.readSync(fd,tail,0,tailLen,size-tailLen);
  let eocd=-1;
  for(let i=tailLen-22;i>=0;i--) if(tail.readUInt32LE(i)===0x06054b50){ eocd=i; break; }
  if(eocd<0) throw new Error('找不到 EOCD');
  const n=tail.readUInt16LE(eocd+10), cdSize=tail.readUInt32LE(eocd+12), cdOff=tail.readUInt32LE(eocd+16);
  if(cdOff===0xffffffff) throw new Error('zip64 暂不支持');
  const cd=Buffer.alloc(cdSize); fs.readSync(fd,cd,0,cdSize,cdOff);
  const out=[]; let p=0;
  for(let i=0;i<n;i++){
    if(cd.readUInt32LE(p)!==0x02014b50) throw new Error('中央目录签名不对 @'+p);
    const flags=cd.readUInt16LE(p+8), method=cd.readUInt16LE(p+10);
    const crc=cd.readUInt32LE(p+16), csize=cd.readUInt32LE(p+20), usize=cd.readUInt32LE(p+24);
    const nlen=cd.readUInt16LE(p+28), elen=cd.readUInt16LE(p+30), clen=cd.readUInt16LE(p+32);
    const lho=cd.readUInt32LE(p+42);
    const name=cd.slice(p+46,p+46+nlen).toString('utf8');
    const lh=Buffer.alloc(30); fs.readSync(fd,lh,0,30,lho);
    const lnlen=lh.readUInt16LE(26), lelen=lh.readUInt16LE(28);
    const dataOff=lho+30+lnlen+lelen;
    const raw=Buffer.alloc(csize); if(csize) fs.readSync(fd,raw,0,csize,dataOff);
    out.push({name,method,flags,crc,csize,usize,raw});
    p+=46+nlen+elen+clen;
  }
  fs.closeSync(fd);
  return out;
}

/** 写 zip：有 raw 的原样搬，没有的按 store 决定压缩 */
function writeZip(entries,out,when){
  const d=when||new Date();
  const time=((d.getHours()&31)<<11)|((d.getMinutes()&63)<<5)|((d.getSeconds()/2)&31);
  const date=(((d.getFullYear()-1980)&127)<<9)|(((d.getMonth()+1)&15)<<5)|(d.getDate()&31);
  const cen=[]; let off=0;
  const fd=fs.openSync(out,"w");
  const put=b=>{ fs.writeSync(fd,b); };
  for(const e of entries){
    const name=Buffer.from(e.name,'utf8');
    let {method,crc,csize,usize,raw}=e;
    if(!raw){ const data=Buffer.isBuffer(e.data)?e.data:Buffer.from(e.data,'utf8');
      crc=crc32(data); usize=data.length;
      const def=zlib.deflateRawSync(data,{level:9});
      if(e.store||def.length>=data.length){ method=0; raw=data; } else { method=8; raw=def; }
      csize=raw.length; }
    const lh=Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50,0); lh.writeUInt16LE(20,4); lh.writeUInt16LE(0x0800,6);
    lh.writeUInt16LE(method,8); lh.writeUInt16LE(time,10); lh.writeUInt16LE(date,12);
    lh.writeUInt32LE(crc,14); lh.writeUInt32LE(csize,18); lh.writeUInt32LE(usize,22);
    lh.writeUInt16LE(name.length,26); lh.writeUInt16LE(0,28);
    put(lh); put(name); put(raw);
    const ch=Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50,0); ch.writeUInt16LE(20,4); ch.writeUInt16LE(20,6);
    ch.writeUInt16LE(0x0800,8); ch.writeUInt16LE(method,10); ch.writeUInt16LE(time,12); ch.writeUInt16LE(date,14);
    ch.writeUInt32LE(crc,16); ch.writeUInt32LE(csize,20); ch.writeUInt32LE(usize,24);
    ch.writeUInt16LE(name.length,28); ch.writeUInt16LE(0,30); ch.writeUInt16LE(0,32);
    ch.writeUInt16LE(0,34); ch.writeUInt16LE(0,36); ch.writeUInt32LE(0,38); ch.writeUInt32LE(off,42);
    cen.push(ch,name);
    off+=30+name.length+raw.length;
  }
  const cdb=Buffer.concat(cen);
  const eo=Buffer.alloc(22);
  eo.writeUInt32LE(0x06054b50,0); eo.writeUInt16LE(0,4); eo.writeUInt16LE(0,6);
  eo.writeUInt16LE(entries.length,8); eo.writeUInt16LE(entries.length,10);
  eo.writeUInt32LE(cdb.length,12); eo.writeUInt32LE(off,16); eo.writeUInt16LE(0,20);
  put(cdb); put(eo); fs.closeSync(fd);
}
module.exports={readZip,writeZip,crc32};
