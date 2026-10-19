(()=>{
  const $=id=>document.getElementById(id);
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  async function api(url,opt={}){
    const r=await fetch(url,{credentials:'same-origin',headers:{'Content-Type':'application/json',...(opt.headers||{})},...opt});
    let d={};
    try{d=await r.json()}catch{}
    if(!r.ok)throw Error(d.message||'Request failed ('+r.status+')');
    return d;
  }
  function status(t){$('notificationStatus').textContent=t}
  async function load(){
    const d=await api('/api/notifications');
    $('notificationCount').textContent='Unread: '+(d.unreadCount||0);
    $('notificationList').innerHTML=d.data.length?d.data.map(n=>
      '<article class="bga-item"><strong>'+esc(n.title)+'</strong> '+
      (!n.isRead?'<span class="bga-unread">New</span>':'')+
      '<p>'+esc(n.body)+'</p><small class="bga-muted">'+
      esc(new Date(n.createdAt).toLocaleString())+
      '</small><div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">'+
      (!n.isRead?'<button data-read="'+esc(n.id)+'">Mark read</button>':'')+
      '<a href="'+esc(n.link||'/notifications')+'">Open</a> '+
      '<button data-delete="'+esc(n.id)+'">Delete</button></div></article>'
    ).join(''):'<p class="bga-muted">You have no notifications yet.</p>';
  }
  $('notificationList').addEventListener('click',async e=>{
    const r=e.target.closest('[data-read]');
    const x=e.target.closest('[data-delete]');
    try{
      if(r){
        await api('/api/notifications/'+encodeURIComponent(r.dataset.read)+'/read',{method:'POST'});
        await load();status('Notification marked as read.');
      }else if(x){
        await api('/api/notifications/'+encodeURIComponent(x.dataset.delete),{method:'DELETE'});
        await load();status('Notification deleted.');
      }
    }catch(err){status(err.message)}
  });
  $('readAll').addEventListener('click',async()=>{
    try{
      await api('/api/notifications/read-all',{method:'POST'});
      await load();status('All notifications marked as read.');
    }catch(e){status(e.message)}
  });
  $('clearAll').addEventListener('click',async()=>{
    if(!confirm('Clear all your notifications?'))return;
    try{
      await api('/api/notifications',{method:'DELETE'});
      await load();status('Notifications cleared.');
    }catch(e){status(e.message)}
  });
  load().catch(e=>status('Please log in to view notifications.'));
})();
