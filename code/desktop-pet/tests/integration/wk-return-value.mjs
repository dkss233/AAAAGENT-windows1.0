// No window, model, backend or device: characterize WK result conversion only.
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const project=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),out=resolve(project,'../../artifacts/W0-I/panel-stability-01/native/wk-return');mkdirSync(out,{recursive:true});
writeFileSync(join(out,'main.swift'),String.raw`
import AppKit
import WebKit
final class Probe:NSObject,WKNavigationDelegate {
 var web:WKWebView!,rows=[[String:Any]]()
 func webView(_ webView:WKWebView,didFinish navigation:WKNavigation!){
  let expressions=["(async()=>{window.sample=1})()","void (()=>{(async()=>{window.sample=2})()})()","window.sample"]
  func next(_ i:Int){
   if i==expressions.count {
    let good=self.rows[0]["error"] as? String=="JavaScript execution returned a result of an unsupported type" && self.rows[1]["error"]==nil && self.rows[2]["value"] as? Int==2
    let data=try! JSONSerialization.data(withJSONObject:["passed":good,"rows":self.rows,"windows":NSApp.windows.count,"modelDeviceCalls":0],options:[.prettyPrinted,.sortedKeys]);try! data.write(to:URL(fileURLWithPath:CommandLine.arguments[1]));self.web.stopLoading();exit(good ? 0:1)
   }
   webView.evaluateJavaScript(expressions[i]){value,error in
    var row:[String:Any]=["expression":expressions[i]]
    if let error=error as NSError? {row["error"]=error.localizedDescription;row["domain"]=error.domain;row["code"]=error.code}
    if let value {row["value"]=value};self.rows.append(row);next(i+1)
   }
  };next(0)
 }
}
let app=NSApplication.shared;app.setActivationPolicy(.prohibited)
let p=Probe();p.web=WKWebView(frame:CGRect(x:0,y:0,width:32,height:32));p.web.navigationDelegate=p;p.web.loadHTMLString("<!doctype html><title>return only</title>",baseURL:nil)
DispatchQueue.main.asyncAfter(deadline:.now()+12){exit(2)}
app.run()
`);
execFileSync('swiftc',['-module-cache-path',join(project,'desktop/.cache/swift'),'-framework','AppKit','-framework','WebKit',join(out,'main.swift'),'-o',join(out,'probe')]);
execFileSync(join(out,'probe'),[join(out,'result.json')],{timeout:18000});console.log(readFileSync(join(out,'result.json'),'utf8'));
