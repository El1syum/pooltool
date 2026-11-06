import assert from 'node:assert/strict';
import path from 'node:path';
import {realpath,stat} from 'node:fs/promises';

/** Refuse input/output and output/output aliases before writing any artifact. */
export async function assertDistinctArtifacts(input,outputs){
  const source=await realpath(input),sourceStat=await stat(source);
  const seen=[{resolved:source,stat:sourceStat}];
  for(const output of outputs){
    const target=path.resolve(output),resolved=await realpath(target).catch(()=>target),targetStat=await stat(target).catch(()=>null);
    for(const previous of seen){
      assert.notEqual(resolved.toLowerCase(),previous.resolved.toLowerCase(),'Artifacts must not replace the source or each other');
      assert.ok(!targetStat||!previous.stat||targetStat.dev!==previous.stat.dev||targetStat.ino!==previous.stat.ino,'Artifacts must not alias the source or each other');
    }
    seen.push({resolved,stat:targetStat});
  }
}
