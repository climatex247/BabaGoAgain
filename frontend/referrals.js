'use strict';

document.addEventListener('DOMContentLoaded', async () => {
  const linkInput = document.getElementById('referralLink');
  const copyButton = document.getElementById('copyReferral');
  const shareButton = document.getElementById('shareReferral');
  const status = document.getElementById('status');
  const qrContainer = document.getElementById('referralQr');
  const downloadQrButton = document.getElementById('downloadReferralQr');

  function show(message, error = false) {
    status.textContent = message;
    status.style.color = error ? '#b91c1c' : '#166534';
  }

  try {
    const response = await fetch('/api/referrals/me', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      cache: 'no-store'
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.success || !result.data?.referralCode) {
      if (response.status === 401) {
        location.href = '/login?next=%2Freferrals';
        return;
      }
      throw new Error(result.message || 'Could not load your referral details.');
    }

    const data = result.data;
    const url = new URL('/register', window.location.origin);
    url.searchParams.set('ref', data.referralCode);
    linkInput.value = url.toString();
    copyButton.disabled = false;
    shareButton.disabled = false;
    if (typeof QRCode === 'undefined') {
      const fallback = document.createElement('img');
      fallback.alt = 'Referral QR code';
      fallback.width = 220; fallback.height = 220;
      fallback.src = 'https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=' + encodeURIComponent(url.toString());
      fallback.onerror = () => show('Your referral link is ready, but the QR image service could not load. Use Copy link to invite members.', true);
      qrContainer.replaceChildren(fallback);
      downloadQrButton.disabled = false;
    } else {
      qrContainer.replaceChildren();
      new QRCode(qrContainer, {
        text: url.toString(), width: 220, height: 220,
        colorDark: '#111827', colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.H
      });
      downloadQrButton.disabled = false;
    }

    document.getElementById('directReferrals').textContent = Number(data.directReferrals || 0);
    document.getElementById('verifiedDirectReferrals').textContent = Number(data.verifiedDirectReferrals || 0);
    document.getElementById('matrixChildren').textContent = Number(data.matrixChildren || 0);
    document.getElementById('matrixPosition').textContent =
      data.matrixPosition ? String(data.matrixPosition).toUpperCase() : 'Root / Not placed';
    document.getElementById('sponsor').textContent =
      'Invited by: ' + (data.sponsorName || 'No sponsor recorded');
    document.getElementById('matrixParent').textContent =
      'Matrix parent: ' + (data.matrixParentName || 'Not applicable');
  } catch (error) {
    show(error.message || 'Could not load referral information.', true);
  }

  downloadQrButton.addEventListener('click', () => {
    const image = qrContainer.querySelector('img');
    const canvas = qrContainer.querySelector('canvas');
    const source = canvas?.toDataURL('image/png') || image?.src;
    if (!source) { show('QR code is not ready yet.', true); return; }
    const link = document.createElement('a');
    link.href = source;
    link.download = 'baba-go-again-referral-qr.png';
    document.body.appendChild(link);
    link.click();
    link.remove();
    show('Your referral QR code has been downloaded.');
  });

  copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(linkInput.value);
      show('Referral link copied. You can now share it.');
    } catch {
      linkInput.focus();
      linkInput.select();
      show('Select and copy the referral link above.');
    }
  });

  shareButton.addEventListener('click', async () => {
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Join Baba Go Again', text: 'Join Baba Go Again using my invitation link:', url: linkInput.value });
      } else {
        await navigator.clipboard.writeText(linkInput.value);
        show('Referral link copied. Paste it into your message.');
      }
    } catch (error) {
      if (error.name !== 'AbortError') show('Sharing was not completed. You can copy the link instead.', true);
    }
  });
});