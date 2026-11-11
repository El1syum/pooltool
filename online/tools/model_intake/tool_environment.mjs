import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {realpath,stat} from 'node:fs/promises';
import {existsSync} from 'node:fs';

export const TOOL_ROOT=process.env.MODEL_TOOLS_ROOT?path.resolve(process.env.MODEL_TOOLS_ROOT):path.dirname(fileURLToPath(import.meta.url));
const requireTool=createRequire(path.join(TOOL_ROOT,'package.json'));
export async function toolImport(name){
  let resolved=requireTool.resolve(name);
  if(name==='three')resolved=path.join(path.dirname(resolved),'three.module.js');
  else if(resolved.endsWith('.cjs')){const esm=resolved.slice(0,-4);if(existsSync(esm+'.mjs'))resolved=esm+'.mjs';else if(existsSync(esm+'.js'))resolved=esm+'.js';}
  const namespace=await import(pathToFileURL(resolved).href);
  return namespace.default&&typeof namespace.default==='object'?{...namespace.default,...namespace}:namespace;
}
export async function preparationPaths({outputRequired=true}={}){
  const {values}=parseArgs({options:{input:{type:'string'},output:{type:'string'},force:{type:'boolean',default:false}}});
  if(!values.input||outputRequired&&!values.output)throw Error('Usage: --input /absolute/source.glb --output /absolute/derivative.glb [--force]');
  const input=await realpath(path.resolve(values.input));
  if(!values.output)return{input};
  const output=path.resolve(values.output),existing=await stat(output).catch(()=>null),source=await stat(input);
  if(input.toLowerCase()===(await realpath(output).catch(()=>output)).toLowerCase()||existing&&source.dev===existing.dev&&source.ino===existing.ino)throw Error('Refusing to overwrite the source file');
  if(existing&&!values.force)throw Error('Output exists; use --force only for an existing derivative');
  return{input,output};
}
