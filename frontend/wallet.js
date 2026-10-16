'use strict';
document.addEventListener('DOMContentLoaded', () => {
  const $ = id => document.getElementById(id);
  const message = $('walletMessage');
  const naira = kobo => new Intl.NumberFormat('en-NG',{style:'currency',currency:'NGN',maximumFractionDigits:2}).format(Number(kobo||0)/100);
  async function api(path, options={}) {
    const response = await fetch(path,{credentials:'same-origin',headers:{Accept:'application/json','Content-Type':'application/json',...(options.headers||{})},...options});
    const data = await response.json().catch(()=>({}));
    if (response.status===401) { location.href='/login'; throw new Error('Please log in again.'); }
    if (!response.ok || data.success!==true) throw new Error(data.message||'Request failed.');
    return data;
  }
  function card(title, body, meta='') { const el=document.createElement('article');el.className='community-card';const h=document.createElement('h3');h.textContent=title;el.append(h);const p=document.createElement('p');p.textContent=body;el.append(p);if(meta){const m=document.createElement('div');m.className='card-meta';m.textContent=meta;el.append(m);}return el; }
  async function load() {
    try {
      const result=await api('/api/wallet/me'); const d=result.data;
      $('walletBalance').textContent=naira(d.balanceKobo);
      const payouts=$('payoutList');payouts.replaceChildren();
      if(!d.payouts.length)payouts.append(card('No payout requests','Your payout history will appear here.'));
      d.payouts.forEach(p=>payouts.append(card(`${naira(p.amountKobo)} — ${p.status}`,`${p.recipientType==='opay_wallet'?'OPay wallet':'Bank account'} · Ref ${p.reference}`,`${new Date(p.requestedAt).toLocaleString()}${p.failureReason?' · '+p.failureReason:''}`)));
      const txs=$('transactionList');txs.replaceChildren();
      if(!d.transactions.length)txs.append(card('No transactions yet','Volunteer programme credits and payout holds will appear here.'));
      d.transactions.forEach(t=>txs.append(card(`${t.amountKobo>=0?'+':'−'}${naira(Math.abs(t.amountKobo))} · ${t.type.replaceAll('_',' ')}`,t.description,`${new Date(t.createdAt).toLocaleString()} · ${t.reference}`)));
      if(!d.opayConfigured) message.textContent='Wallet view is available. Automated OPay transfers are not enabled until the administrator configures approved merchant credentials.';
    } catch(e) { message.textContent=e.message; }
  }
  function destinationFields() {
    const bank=$('recipientType').value==='bank'; $('bankFields').hidden=!bank; $('opayFields').hidden=bank;
    $('phoneNumber').required=!bank; $('bankCode').required=bank; $('bankAccountNumber').required=bank;
  }
  $('recipientType').addEventListener('change',destinationFields); destinationFields();
  $('payoutForm').addEventListener('submit',async e=>{
    e.preventDefault(); if(!e.currentTarget.reportValidity())return;
    const button=e.currentTarget.querySelector('button[type=submit]');button.disabled=true;message.textContent='Submitting payout request…';
    const payload={amountNaira:Number($('amountNaira').value),recipientType:$('recipientType').value,recipientName:$('recipientName').value.trim(),phoneNumber:$('phoneNumber').value.trim(),bankCode:$('bankCode').value.trim(),bankAccountNumber:$('bankAccountNumber').value.trim()};
    try { const result=await api('/api/wallet/payouts',{method:'POST',body:JSON.stringify(payload)});message.textContent=result.message;e.currentTarget.reset();destinationFields();await load(); }
    catch(err){message.textContent=err.message;}
    finally{button.disabled=false;}
  });
  $('logoutButton').addEventListener('click',async()=>{try{await api('/api/auth/logout',{method:'POST',body:'{}'});}finally{location.href='/login';}});
  load();
});
