"use strict";
document.addEventListener('DOMContentLoaded', async () => {
  const $ = id => document.getElementById(id);
  const message = (text) => { $('globalMessage').textContent = text || ''; };
  const api = async (url, options={}) => {
    const response = await fetch(url, { credentials:'same-origin', ...options, headers:{Accept:'application/json', ...(options.body ? {'Content-Type':'application/json'} : {}), ...(options.headers||{})} });
    const data = await response.json().catch(()=>({}));
    if (!response.ok) { if (response.status===401) location.href='/login'; throw new Error(data.message || 'Request failed.'); }
    return data;
  };
  const element = (tag, cls, text) => { const node=document.createElement(tag); if(cls)node.className=cls; if(text!==undefined)node.textContent=text; return node; };
  const dateText = value => { const date=new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(); };
  let currentUserId; try { const me=await api('/api/auth/me'); currentUserId=String(me.user.id ?? me.user.userId ?? ''); $('welcomeText').textContent=`Welcome, ${me.user.name}. Share updates and take part in community activities.`; }
  catch(e){ message(e.message); return; }
  $('logoutButton').addEventListener('click', async()=>{try{await api('/api/auth/logout',{method:'POST'});location.href='/login';}catch(e){message(e.message);}});


  async function deleteCommunityPost(id) {
    if (!confirm('Delete this post and all its comments? This cannot be undone.')) return;
    try {
      await api('/api/community/posts/' + encodeURIComponent(id), {method:'DELETE'});
      message('Post deleted.');
      await loadFeed();
    } catch(e) { message(e.message); }
  }

  async function deleteCommunityComment(id, postId) {
    if (!confirm('Delete this comment? This cannot be undone.')) return;
    try {
      await api('/api/community/comments/' + encodeURIComponent(id), {method:'DELETE'});
      message('Comment deleted.');
      await loadFeed();
    } catch(e) { message(e.message); }
  }

  function appendCommunityComment(container, comment, postId) {
    const row = element('div','comment-row');
    row.append(element('p','comment',comment.authorName + ': ' + comment.body));if(!currentUserId || String(comment.userId)!==currentUserId){const report=element('button','community-report','Report comment');report.type='button';report.addEventListener('click',()=>reportCommunityContent('comment',comment.id));row.append(report);}
    if (currentUserId && String(comment.userId) === currentUserId) {
      const remove = element('button','comment-delete','Delete');
      remove.type = 'button';
      remove.addEventListener('click', () => deleteCommunityComment(comment.id, postId));
      row.append(remove);
    }
    container.append(row);
  }


  async function cancelCommunityAttendance(id) {
    if (!confirm('Cancel your attendance for this event?')) return;
    try {
      const r = await api('/api/community/events/' + encodeURIComponent(id) + '/cancel-attendance', {method:'POST'});
      message(r.message);
      await loadEvents();
    } catch(e) { message(e.message); }
  }

  async function leaveCommunityGroup(id) {
    if (!confirm('Leave this group?')) return;
    try {
      const r = await api('/api/community/groups/' + encodeURIComponent(id) + '/leave', {method:'POST'});
      message(r.message);
      await loadGroups();
    } catch(e) { message(e.message); }
  }

  async function deleteCommunityEvent(id) {
    if (!confirm('Delete this event and its attendance records? This cannot be undone.')) return;
    try {
      const r = await api('/api/community/events/' + encodeURIComponent(id), {method:'DELETE'});
      message(r.message);
      await loadEvents();
    } catch(e) { message(e.message); }
  }


  async function reportCommunityContent(targetType, targetId) {
    const reasons = {
      '1':'spam',
      '2':'harassment',
      '3':'hate_or_threats',
      '4':'misinformation',
      '5':'inappropriate_content',
      '6':'impersonation',
      '7':'other'
    };
    const choice = prompt('Report reason:\n1 Spam\n2 Harassment\n3 Hate or threats\n4 Misinformation\n5 Inappropriate content\n6 Impersonation\n7 Other');
    if (choice === null) return;
    const reason = reasons[choice.trim()];
    if (!reason) { message('Choose a reason from 1 to 7.'); return; }
    const details = prompt('Additional details (optional):') || '';
    try {
      const result = await api('/api/community/reports', {
        method:'POST',
        body:JSON.stringify({targetType,targetId,reason,details})
      });
      message(result.message);
    } catch(e) { message(e.message); }
  }

  function addReportButton(actions, type, id) {
    const button = element('button','community-report','Report');
    button.type = 'button';
    button.addEventListener('click',()=>reportCommunityContent(type,id));
    actions.append(button);
  }

  async function loadFeed(){const data=await api('/api/community/feed');const list=$('feedList');list.replaceChildren();if(!data.data.length){list.append(element('p','card-meta','No posts yet. Be the first to share an update.'));return;}for(const post of data.data){const card=element('article','community-card');card.append(element('h3','',post.authorName),element('p','',post.body),element('div','card-meta',`${dateText(post.createdAt)} · ${post.commentCount} comments`));const actions=element('div','card-actions');const toggle=element('button','', 'Comments');actions.append(toggle);if(currentUserId && String(post.userId)===currentUserId){const remove=element('button','community-delete','Delete post');remove.type='button';remove.addEventListener('click',()=>deleteCommunityPost(post.id));actions.append(remove);}else{addReportButton(actions,'post',post.id);}card.append(actions);const comments=element('div','comment-list');comments.hidden=true;toggle.addEventListener('click',async()=>{comments.hidden=!comments.hidden;if(!comments.hidden&&comments.dataset.loaded!=='1'){try{const result=await api(`/api/community/posts/${encodeURIComponent(post.id)}/comments`);for(const c of result.data)appendCommunityComment(comments,c,post.id);comments.dataset.loaded='1';}catch(e){message(e.message);}}});const form=element('form','inline-comment');const input=element('input');input.maxLength=1000;input.placeholder='Write a comment';input.required=true;input.setAttribute('aria-label','Write a comment');const send=element('button','', 'Comment');send.type='submit';form.append(input,send);form.addEventListener('submit',async e=>{e.preventDefault();try{const result=await api(`/api/community/posts/${encodeURIComponent(post.id)}/comments`,{method:'POST',body:JSON.stringify({body:input.value})});appendCommunityComment(comments,result.data,post.id);comments.dataset.loaded='1';input.value='';comments.hidden=false;}catch(err){message(err.message);}});comments.append(form);card.append(comments);list.append(card);}}
  $('postForm').addEventListener('submit',async e=>{e.preventDefault();const button=e.currentTarget.querySelector('button');button.disabled=true;try{await api('/api/community/posts',{method:'POST',body:JSON.stringify({body:$('postBody').value})});$('postBody').value='';message('Post published.');await loadFeed();}catch(err){message(err.message);}finally{button.disabled=false;}});
  async function loadGroups(){const result=await api('/api/community/groups');const list=$('groupList');list.replaceChildren();if(!result.data.length)list.append(element('p','card-meta','No groups yet. Create one to get started.'));for(const g of result.data){const card=element('article','community-card');card.append(element('h3','',g.name),element('p','',g.description||'No description provided.'),element('div','card-meta',`${g.memberCount} members · Created by ${g.creatorName}`));if(!g.joined){const button=element('button','', 'Join group');button.addEventListener('click',async()=>{try{await api(`/api/community/groups/${encodeURIComponent(g.id)}/join`,{method:'POST'});await loadGroups();message('You joined the group.');}catch(e){message(e.message);}});card.append(button);}else {card.append(element('span','card-meta','You are a member'));if(String(g.creatorId||'')!==String(currentUserId)){addReportButton(card,'group',g.id);const leave=element('button','','Leave group');leave.type='button';leave.addEventListener('click',()=>leaveCommunityGroup(g.id));card.append(leave);}}list.append(card);}}
  $('groupForm').addEventListener('submit',async e=>{e.preventDefault();try{await api('/api/community/groups',{method:'POST',body:JSON.stringify({name:$('groupName').value,description:$('groupDescription').value})});e.currentTarget.reset();message('Group created.');await loadGroups();}catch(err){message(err.message);}});
  async function loadEvents(){const result=await api('/api/community/events');const list=$('eventList');list.replaceChildren();if(!result.data.length)list.append(element('p','card-meta','No events yet. Create the first event.'));for(const ev of result.data){const card=element('article','community-card');card.append(element('h3','',ev.title),element('p','',ev.description||'No additional details.'),element('div','card-meta',`${dateText(ev.startsAt)} · ${ev.location||'Location not specified'} · ${ev.attendeeCount} attending`));if(!ev.attending&&Date.parse(ev.startsAt)>Date.now()){const button=element('button','', 'Attend');button.addEventListener('click',async()=>{try{await api(`/api/community/events/${encodeURIComponent(ev.id)}/attend`,{method:'POST'});await loadEvents();message('You are registered for the event.');}catch(e){message(e.message);}});card.append(button);}else if(ev.attending){card.append(element('span','card-meta','You are attending'));if(Date.parse(ev.startsAt)>Date.now()){const cancel=element('button','','Cancel attendance');cancel.type='button';cancel.addEventListener('click',()=>cancelCommunityAttendance(ev.id));card.append(cancel);}}if(String(ev.creatorId||'')!==String(currentUserId))addReportButton(card,'event',ev.id);if(String(ev.creatorId||'')===String(currentUserId)){const remove=element('button','','Delete event');remove.type='button';remove.addEventListener('click',()=>deleteCommunityEvent(ev.id));card.append(remove);}list.append(card);}}
  $('eventForm').addEventListener('submit',async e=>{e.preventDefault();const local=$('eventStartsAt').value;try{await api('/api/community/events',{method:'POST',body:JSON.stringify({title:$('eventTitle').value,description:$('eventDescription').value,location:$('eventLocation').value,startsAt:local?new Date(local).toISOString():''})});e.currentTarget.reset();message('Event created.');await loadEvents();}catch(err){message(err.message);}});
  $('volunteerForm').addEventListener('submit',async e=>{e.preventDefault();try{const result=await api('/api/volunteers/apply',{method:'POST',body:JSON.stringify({interests:$('volunteerInterests').value,availability:$('volunteerAvailability').value})});message(result.message);e.currentTarget.reset();}catch(err){message(err.message);}});
  try { await Promise.all([loadFeed(),loadGroups(),loadEvents()]); } catch(e) { message(e.message); }
});
