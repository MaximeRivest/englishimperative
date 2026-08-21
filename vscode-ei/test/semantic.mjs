import * as fs from "node:fs";
import { buildDependencyGraph, changedDependencies, dependencyMap } from "../out/core/semantic.js";
import { parse } from "../out/core/parser.js";
import { saveCache, sha, stmtKey } from "../out/core/cache.js";
import { compile, staleness } from "../out/core/compiler.js";

let failures=0;
function check(name, ok, extra="") { console.log(`${ok?"PASS":"FAIL"}  ${name}${extra?" — "+extra:""}`); if(!ok) failures++; }

const source=`Set the tax rate to twenty percent.
Calculate a total from a price.
Print the total for one hundred dollars.
Print hello.
`;
const units=parse(source).units.filter(x=>x.kind==="statement");
const ids=["rate","total","show","hello"];
const codes=[
  "tax_rate = 0.2",
  "def total(price):\n    return price * (1 + tax_rate)",
  "print(total(100))",
  "print('hello')",
];
const inputs=units.map((unit,i)=>({unit,code:codes[i],nodeId:ids[i],ordinal:i}));
const graph=await buildDependencyGraph("python","test:model","empty",source,inputs);
const byId=new Map(graph.nodes.map(n=>[n.id,n]));
check("AST: assignment defines tax_rate",byId.get("rate").facts.defines.includes("tax_rate"));
check("AST: function reads global tax_rate",byId.get("total").facts.reads.includes("tax_rate"));
check("AST: function signature captured",byId.get("total").facts.functions[0].parameters[0]==="price");
check("graph: total depends on rate",byId.get("total").dependencies.some(d=>d.nodeId==="rate"&&d.symbols.includes("tax_rate")));
check("graph: call depends on total",byId.get("show").dependencies.some(d=>d.nodeId==="total"&&d.symbols.includes("total")));
check("graph: unrelated print is independent",byId.get("hello").dependencies.length===0);

const implCodes=[...codes]; implCodes[1]="def total(price):\n    return (price + price * tax_rate)";
const implGraph=await buildDependencyGraph("python","test:model","empty",source,units.map((unit,i)=>({unit,code:implCodes[i],nodeId:ids[i],ordinal:i})));
check("hash: implementation change detected",implGraph.nodes[1].implementationHash!==graph.nodes[1].implementationHash);
check("hash: implementation keeps interface",implGraph.nodes[1].interfaceHash===graph.nodes[1].interfaceHash);

const apiCodes=[...codes]; apiCodes[1]="def total(price, country):\n    return price * (1 + tax_rate)";
const apiGraph=await buildDependencyGraph("python","test:model","empty",source,units.map((unit,i)=>({unit,code:apiCodes[i],nodeId:ids[i],ordinal:i})));
check("hash: signature changes interface",apiGraph.nodes[1].interfaceHash!==graph.nodes[1].interfaceHash);
const accepted=dependencyMap(graph.nodes[2],graph);
check("pin: caller sees changed function interface",changedDependencies(accepted,apiGraph.nodes[2],apiGraph).includes("total"));

const effectSource="Read settings.\nSend data.\nDelete temporary files.\nUse a name chosen at runtime.\n";
const eu=parse(effectSource).units.filter(x=>x.kind==="statement");
const effectCodes=["open('settings.json').read()","requests.get('https://example.com')","os.remove('tmp.txt')","globals()[name]()"];
const eg=await buildDependencyGraph("python","test:model","empty",effectSource,eu.map((unit,i)=>({unit,code:effectCodes[i],nodeId:`e${i}`,ordinal:i})));
check("effects: file read",eg.nodes[0].facts.effects.includes("reads_files"));
check("effects: network",eg.nodes[1].facts.effects.includes("uses_network"));
check("effects: deletion",eg.nodes[2].facts.effects.includes("deletes_data"));
check("effects: dynamic code is conservative",eg.nodes[3].facts.dynamic&&eg.nodes[3].facts.effects.includes("unknown_dynamic"));

// Precise editor cascade from a saved graph.
const file="/tmp/ei-semantic-cascade.ei";
fs.writeFileSync(file,source);
const pins={};
for(const n of graph.nodes) pins[n.stmtKey]={code:codes[n.ordinal],stmt:n.stmt,at:Date.now(),automatic:true,acceptedDependencies:dependencyMap(n,graph)};
saveCache(file,{version:2,translations:{},pins,survey:{key:"test",value:{target:"python",preambleEnd:0,uses:[],definitions:[]}},graph});
const cfg={engine:"http",httpUrl:"unused",httpApiKey:"",httpModel:"model",piModel:"",piModeFile:""};
// Match graph engine identity used by staleness.
graph.engineId="http:model"; graph.briefsHash=sha("").slice(0,16); saveCache(file,{version:2,translations:{},pins,survey:{key:"test",value:{target:"python",preambleEnd:0,uses:[],definitions:[]}},graph});
const edited=source.replace("twenty percent","twenty-five percent");
const stale=staleness(file,edited,cfg);
check("cascade: changed root only is stale",JSON.stringify(stale.staleLines)==="[0]",JSON.stringify(stale.staleLines));
check("cascade: only true dependents cascade",stale.dependentLines.includes(1)&&stale.dependentLines.includes(2)&&!stale.dependentLines.includes(3),JSON.stringify(stale.dependentLines));
check("cascade: pinned dependents marked for review",stale.reasons.get(1)?.includes("pinned")===true);

// A pinned provider changes its public signature. Locked build must reject the
// still-pinned caller, without calling a model.
const changedPins=structuredClone(pins);
changedPins[graph.nodes[1].stmtKey].code="def total(price, country):\n    return price * (1 + tax_rate)";
saveCache(file,{version:2,translations:{},pins:changedPins,survey:{key:sha("http:model\u0000"+source).slice(0,24),value:{target:"python",preambleEnd:0,uses:[],definitions:[]}},graph});
const locked=await compile(file,source,{...cfg,httpUrl:"http://127.0.0.1:1"},{translateMissing:false,locked:true});
check("locked: changed interface blocks pinned caller",locked.diagnostics.some(d=>d.code==="pinned-dependency"&&d.severity==="error"));

console.log(failures?`\n${failures} FAILURES`:"\nALL SEMANTIC TESTS PASS");
process.exit(failures?1:0);
