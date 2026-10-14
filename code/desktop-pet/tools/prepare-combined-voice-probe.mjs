import {createCipheriv,createHash,randomBytes} from 'node:crypto';
import {prepareNativeVoiceProbe} from './wechat-native-voice-probe.mjs';
/** Pure preparation for the explicitly authorized single FILE+VOICE message. No network or TTS. */
export async function prepareCombinedVoiceProbe({wav,userId,signal}){
 const native=await prepareNativeVoiceProbe({wav,userId,signal});let key,ciphertext,message;
 try{signal.throwIfAborted();key=randomBytes(16);const cipher=createCipheriv('aes-128-ecb',key,null),body=cipher.update(wav),tail=cipher.final();
  try{ciphertext=Buffer.concat([body,tail]);}finally{body.fill(0);tail.fill(0);}
  const uploadRequest={filekey:randomBytes(16).toString('hex'),media_type:3,to_user_id:userId,rawsize:wav.length,rawfilemd5:createHash('md5').update(wav).digest('hex'),filesize:ciphertext.length,no_need_thumb:true,aeskey:key.toString('hex')};
  let built=false,disposed=false;
  return {parts:[{kind:'file',encrypted:ciphertext,uploadRequest},{kind:'voice',encrypted:native.encrypted,uploadRequest:native.uploadRequest}],metadata:{file:{format:'wav',bytes:wav.length},voice:native.metadata},
   buildMessage({fileParam,voiceParam,contextToken,clientId}){
    signal.throwIfAborted();if(built||disposed||typeof fileParam!=='string'||!fileParam||fileParam.length>8192)throw Error('Invalid combined message');built=true;
    const original=native.buildMessage({downloadParam:voiceParam,contextToken,clientId});
    message={msg:{...original.msg,item_list:[{type:4,file_item:{media:{encrypt_query_param:fileParam,aes_key:Buffer.from(uploadRequest.aeskey,'ascii').toString('base64'),encrypt_type:1},file_name:'语音对照.wav',len:String(wav.length)}},...original.msg.item_list]}};return message;
   },dispose(){disposed=true;native.dispose();ciphertext.fill(0);uploadRequest.aeskey='';uploadRequest.filekey='';uploadRequest.to_user_id='';if(message){message.msg.context_token='';message.msg.to_user_id='';message.msg.item_list[0].file_item.media.aes_key='';message.msg.item_list[0].file_item.media.encrypt_query_param='';}}
  };
 }catch(e){native.dispose();ciphertext?.fill(0);throw e;}finally{key?.fill(0);}
}
