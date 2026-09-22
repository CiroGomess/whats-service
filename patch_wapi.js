const fs = require('fs');
const path = require('path');

const wapiFile = path.join(__dirname, 'node_modules', 'venom-bot', 'dist', 'lib', 'wapi', 'wapi.js');
let content = fs.readFileSync(wapiFile, 'utf8');

// 1. Corrigir getNewMessageId em wapi.js
const oldGetNewMsgId = 'window.WAPI.getNewMessageId=async function(e,t=!0){const n=t?await WAPI.sendExist(e):await WAPI.returnChat(e);if(n.id){const e=new Object;return e.fromMe=!0,e.id=await WAPI.getNewId().toUpperCase(),e.remote=new Store.WidFactory.createWid(n.id._serialized),e._serialized=`${e.fromMe}_${e.remote}_${e.id}`,new Store.MsgKey(e)}return!1}';

const newGetNewMsgId = 'window.WAPI.getNewMessageId=async function(e,t=!0){try{let n=await WAPI.getChat(e);if(!n)n=t?await WAPI.sendExist(e):await WAPI.returnChat(e);if(!n||!n.id)n=await WAPI.returnChat(e);if(n&&n.id){const k={fromMe:!0,id:(await WAPI.getNewId()).toUpperCase(),remote:(Store.WidFactory&&Store.WidFactory.createWid)?Store.WidFactory.createWid(n.id._serialized||n.id):n.id};k._serialized=`${k.fromMe}_${k.remote._serialized||k.remote}_${k.id}`;if(Store.MsgKey&&typeof Store.MsgKey===\"function\"){try{return new Store.MsgKey(k)}catch(e){return k}}return k}}catch(e){console.warn(\"[Venom Patch] getNewMessageId error:\",e)}return!1}';

if (content.includes(oldGetNewMsgId)) {
  content = content.replace(oldGetNewMsgId, newGetNewMsgId);
  console.log('Successfully patched getNewMessageId in wapi.js');
} else {
  console.log('oldGetNewMsgId not found verbatim, checking partial...');
  const idx = content.indexOf('window.WAPI.getNewMessageId=');
  if (idx !== -1) {
    const endIdx = content.indexOf('return!1}', idx) + 'return!1}'.length;
    console.log('Found getNewMessageId from', idx, 'to', endIdx);
    content = content.substring(0, idx) + newGetNewMsgId + content.substring(endIdx);
    console.log('Replaced getNewMessageId slice successfully.');
  }
}

// 2. Corrigir sendExist para fazer fallback gracioso para returnChat
const oldSendExistRet = 'return a.numberExists||r.t||!r.isUser?a.numberExists||r.t||!r.isGroup?!a.numberExists&&!r.t&&r.id&&"status"!=r.id.user&&r.isBroadcast?WAPI.scope(e,!0,a.status,"The transmission list number does not exist on your chat list, or it does not exist at all!"):r?(n&&await Promise.resolve(true),t?r:WAPI.scope(e,!1,200)):WAPI.scope(e,!0,404):WAPI.scope(e,!0,a.status,"The group number does not exist on your chat list, or it does not exist at all!"):WAPI.scope(e,!0,a.status,"The number does not exist")';

const newSendExistRet = 'return(r||(a&&a.id&&a.id._serialized))?(t?r:WAPI.scope(e,!1,200)):await WAPI.returnChat(e,t,n)';

if (content.includes(oldSendExistRet)) {
  content = content.replace(oldSendExistRet, newSendExistRet);
  console.log('Successfully patched sendExist fallback in wapi.js');
} else {
  console.log('oldSendExistRet not matched verbatim, checking...');
}

fs.writeFileSync(wapiFile, content, 'utf8');
console.log('wapi.js written successfully.');
