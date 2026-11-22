#!/usr/bin/env bash
# Run against a disposable local Builder in the task's cloud Preview.
# Sign in to the local fixture first. This creates a new test project.
set -euo pipefail

browser=coderabbit-agent-browser
"$browser" set viewport 1440 900
"$browser" open http://localhost:5173
"$browser" wait --text 'Recent projects' --timeout 10000
project="$("$browser" eval 'fetch("/api/projects", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({name:"A4 "+crypto.randomUUID(),prompt:"Disposable A4 browser fixture"})}).then(r=>r.json()).then(({project})=>project)' --json)"
id="$(node -e 'const id=JSON.parse(process.argv[1]).data.result.id;if (!/^[a-f0-9-]{36}$/.test(id)) process.exit(1);console.log(id)' "$project")"
name="$(node -e 'console.log(JSON.parse(process.argv[1]).data.result.name)' "$project")"

url="**/api/projects/$id/preview/problems"
trap '"$browser" network unroute "$url" >/dev/null || true; "$browser" set viewport 1440 900 >/dev/null || true' EXIT
"$browser" reload
"$browser" wait --text "$name" --timeout 10000
"$browser" find role button click --name "$name"
"$browser" eval "fetch('/api/projects/$id/files/content',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:'fixture.ts',content:'export const count = 1;\\n'})}).then(r=>{if(!r.ok)throw Error('Could not create fixture file');return true})"
"$browser" find role tab click --name Files --exact
"$browser" wait --text 'fixture.ts' --timeout 10000
"$browser" find role button click --name 'fixture.ts'
"$browser" wait '.monaco-editor .view-line' --timeout 15000
"$browser" click '.monaco-editor .view-line'
"$browser" press Control+a
"$browser" keyboard inserttext 'export const count = 2;'
"$browser" wait --text 'Unsaved changes' --timeout 10000

# This stub is scoped to one read-only endpoint. All auth, files, and chat
# traffic still goes to the real local API. It does not simulate Podman.
"$browser" network route "$url" --body '{"runId":"vite-fixture","phase":"running","logs":"Fixture transform output","problems":[{"id":"compiler","severity":"error","kind":"compile","summary":"Vite could not compile the project","detail":"Fixture transform output","location":{"path":"fixture.ts","line":1,"column":8},"stale":false}]}'
"$browser" find role tab click --name Problems --exact
"$browser" wait --text 'fixture.ts:1:8' --timeout 10000
"$browser" find role button click --name 'Open in Code' --exact
"$browser" wait --text 'Unsaved changes' --timeout 10000
"$browser" eval 'if (!document.querySelector(".monaco-editor .view-lines")?.textContent.replace(/\s/g,"").includes("exportconstcount=2;")) throw Error("Unsaved text lost"); true'
"$browser" find role tab click --name Problems --exact
"$browser" wait --text 'Vite could not compile the project' --timeout 10000
"$browser" find placeholder 'Ask OMP to change anything...' fill 'Keep this unsent message'
"$browser" set viewport 390 780
"$browser" find role tab click --name Problems
"$browser" wait --text 'Vite could not compile the project' --timeout 10000
"$browser" find role button click --name 'Fix with OMP' --exact
"$browser" wait --text 'Review fix draft' --timeout 10000
"$browser" eval '(() => {const field=[...document.querySelectorAll("textarea[data-omp-composer]")].find(e=>e.getClientRects().length); if(!field?.value.includes("fixture.ts:1:8")||!field.value.includes("untrusted build output")) throw Error("Missing diagnostic context"); return true;})()'
"$browser" find placeholder 'Ask OMP to change anything...' fill 'Edited diagnostic draft'
"$browser" press Enter
"$browser" find role button click --name 'Cancel fix draft' --exact
"$browser" eval '(() => {const field=[...document.querySelectorAll("textarea[data-omp-composer]")].find(e=>e.getClientRects().length); if(field?.value!=="Keep this unsent message") throw Error("Original draft lost"); return true;})()'
"$browser" eval "fetch('/api/projects/$id/session').then(r=>r.json()).then(x=>{if(x.events.some(e=>e.type==='user_message'||e.type==='prompt_accepted')) throw Error('Unexpected prompt submission'); return 'No prompt events';})"
"$browser" network unroute "$url"
"$browser" network route "$url" --body '{"runId":"recovered-fixture","phase":"running","logs":"","problems":[]}'
"$browser" find role tab click --name Problems
"$browser" wait --text 'No current problems reported.' --timeout 10000
