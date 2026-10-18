import { test, expect } from 'bun:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigManager } from '../src/configManager';
import { certificateCoversDomains } from '../src/certificateDomains';
test('GUI persists hostname routing and preserves the existing fallback', async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ferrum-host-')),manager=new ConfigManager();
 try{
  const config={listeners:[{tcp:443,haproxy:true,target:{host:'100.83.127.8',tcp:8123},httpMappings:[{hostname:' SHARE.PEXSERVER.COM. ',path:'/',target:{host:'100.69.76.52',tcp:8100}}]}]};
  expect((await manager.validate(config)).errors).toEqual([]);
  const file=join(dir,'config.yml');await manager.write(file,config);const restored=await manager.read(file);
  expect(restored.listeners![0].httpMappings![0].hostname).toBe('share.pexserver.com');
  expect(restored.listeners![0].target).toEqual(config.listeners[0].target);
  for(const hostname of ['https://share.pexserver.com','share.pexserver.com:443','*.pexserver.com','share.pexserver.com\r\nHost: evil']){
   config.listeners[0].httpMappings[0].hostname=hostname;expect((await manager.validate(config)).valid).toBe(false);
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('certificate reuse checks every SAN instead of just existing files',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ferrum-cert-'));
 try{
  for(const [name,domains]of [['play','DNS:play.pexserver.com'],['both','DNS:play.pexserver.com,DNS:share.pexserver.com']]){
   const result=Bun.spawnSync(['openssl','req','-x509','-newkey','ed25519','-nodes','-days','2','-subj','/CN=play.pexserver.com','-addext','subjectAltName='+domains,'-keyout',join(dir,name+'.key'),'-out',join(dir,name+'.pem')]);expect(result.exitCode).toBe(0);
  }
  const play=await readFile(join(dir,'play.pem'),'utf8'),both=await readFile(join(dir,'both.pem'),'utf8');
  expect(certificateCoversDomains(play,['play.pexserver.com'])).toBe(true);
  expect(certificateCoversDomains(play,['play.pexserver.com','share.pexserver.com'])).toBe(false);
  expect(certificateCoversDomains(both,['play.pexserver.com','share.pexserver.com'])).toBe(true);
  expect(certificateCoversDomains(both,['evil.example'])).toBe(false);
  expect(certificateCoversDomains('bad',['play.pexserver.com'])).toBe(false);
 }finally{await rm(dir,{recursive:true,force:true});}
});
