(()=>{const $=id=>document.getElementById(id);const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const videoPlayer=url=>{try{const u=new URL(url);if(u.protocol!=='https:'||!/(^|\.)publit\.io$/i.test(u.hostname))return '<p>Video URL is unavailable.</p>';u.pathname=u.pathname.replace(/\.(mp4|webm|ogv)$/i,'.html');u.search='';return '<div style="position:relative;width:100%;aspect-ratio:16/9;overflow:hidden;border-radius:12px"><iframe src="'+esc(u.href)+'" title="BabaGoAgain video player" loading="lazy" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin" style="position:absolute;inset:0;width:100%;height:100%;border:0"></iframe></div>'}catch{return '<p>Video is unavailable.</p>'}};async function load(){const type=$('filterType').value;try{const r=await fetch('/api/media'+(type?'?type='+type:''));const d=await r.json();if(!r.ok)throw Error(d.message||'Could not load media');$('mediaList').innerHTML=d.data.map(m=>'<article class="bga-item"><h3>'+esc(m.title)+'</h3><p>'+esc(m.description)+'</p><p class="bga-muted">By '+esc(m.authorName)+' · '+esc(new Date(m.createdAt).toLocaleString())+'</p>'+(m.mediaType==='audio'?'<audio class="bga-media" controls preload="metadata" src="'+esc(m.mediaUrl)+'"></audio>':videoPlayer(m.mediaUrl))+'</article>').join('')||'<p class="bga-muted">No media published yet.</p>'}catch(e){$('mediaList').textContent=e.message}}function uploadToPublitio(file,auth){
  return new Promise((resolve,reject)=>{
    const data=new FormData();
    data.append('file',file,file.name);
    data.append('title',auth.title);
    data.append('description',auth.description||'');
    data.append('privacy','0');
    data.append('option_download','1');
    const xhr=new XMLHttpRequest();
    xhr.open('POST','/api/media/upload-file');
    xhr.setRequestHeader('X-BGA-Upload-Token',auth.token);
    xhr.upload.onprogress=e=>{
      if(e.lengthComputable){
        const pct=Math.round(e.loaded/e.total*100);
        $('uploadStatus').textContent='Uploading securely… '+pct+'%';
      }
    };
    xhr.onload=()=>{
      let body;
      try{body=JSON.parse(xhr.responseText)}catch{body={}}
      if(xhr.status>=200&&xhr.status<300&&body.success&&body.id)resolve(body);
      else reject(Error(body.message||body.error||'Publitio upload failed (HTTP '+xhr.status+').'));
    };
    xhr.onerror=()=>reject(Error('Network error while uploading. Check your connection and try again.'));
    xhr.onabort=()=>reject(Error('Upload was cancelled.'));
    xhr.send(data);
  });
}$('reloadMedia').addEventListener('click',load);$('filterType').addEventListener('change',load);$('uploadForm').addEventListener('submit',async e=>{e.preventDefault();const f=$('mediaFile').files[0];if(!f)return;const type=$('mediaType').value;const maxBytes=type==='audio'?25*1024*1024:500*1024*1024;const maxLabel=type==='audio'?'25 MB':'500 MB';if(f.size>maxBytes){$('uploadStatus').textContent='File exceeds the '+maxLabel+' '+type+' upload limit.';return}if(type==='audio'&&!f.type.startsWith('audio/')){$('uploadStatus').textContent='Choose an audio file.';return}if(type==='video'&&!['video/mp4','video/webm'].includes(f.type)){$('uploadStatus').textContent='Choose an MP4 or WebM video.';return}const button=e.submitter;button.disabled=true;try{$('uploadStatus').textContent='Preparing secure Publitio upload…';const authResponse=await fetch('/api/media/upload-auth',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({type,title:$('mediaTitle').value,description:$('mediaDescription').value,mimeType:f.type})});const authData=await authResponse.json();if(!authResponse.ok)throw Error(authData.message||'Could not prepare upload');const uploaded=await uploadToPublitio(f,authData.data);if(!uploaded.id)throw Error('Publitio did not return a file ID.');$('uploadStatus').textContent='Verifying upload and submitting for moderation…';const completeResponse=await fetch('/api/media/upload-complete',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:authData.data.token,fileId:uploaded.id})});const completeData=await completeResponse.json();if(!completeResponse.ok)throw Error(completeData.message||'Could not verify uploaded media');$('uploadStatus').textContent=completeData.message||'Upload complete. Awaiting moderator approval.';$('uploadForm').reset();await load()}catch(err){$('uploadStatus').textContent=err.message||'Upload failed.'}finally{button.disabled=false}});load()})();