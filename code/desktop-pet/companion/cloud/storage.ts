import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isPrivateFileSync, restrictPrivatePathSync } from '../../core/platform-files.js';
import { CloudError } from './protocol.js';

export function prepareSocialDatabase(filename:string):void {
  if(filename===':memory:')return;
  mkdirSync(dirname(filename),{recursive:true,mode:0o700});
  restrictPrivatePathSync(dirname(filename));
  if(!existsSync(filename)) {
    const fd=openSync(filename,'wx',0o600);closeSync(fd);
    restrictPrivatePathSync(filename);
  } else if(!isPrivateFileSync(filename))throw new CloudError('private_social_storage_required');
}

export function readPrivateSocialText(filename:string,max=16000):string {
  const fd=openSync(filename,'r');
  try {
    const stat=fstatSync(fd);
    if(stat.size>max||!isPrivateFileSync(filename,stat))throw new CloudError('private_social_file_required');
    return readFileSync(fd,'utf8');
  } finally { closeSync(fd); }
}

export function writePrivateSocialText(filename:string,body:string,exclusive=true):void {
  mkdirSync(dirname(filename),{recursive:true,mode:0o700});
  restrictPrivatePathSync(dirname(filename));
  if(existsSync(filename)&&!isPrivateFileSync(filename))throw new CloudError('private_social_file_required');
  writeFileSync(filename,body,{encoding:'utf8',mode:0o600,flag:exclusive?'wx':'w'});
  restrictPrivatePathSync(filename);
}
