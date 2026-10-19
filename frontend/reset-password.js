'use strict';

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('resetPasswordForm');
  const msg = document.getElementById('formMessage');
  if (!form) return;

  const button = form.querySelector('button[type="submit"]');
  const token = new URLSearchParams(location.search).get('token') || '';

  if (!token) {
    if (msg) msg.textContent = 'Reset link is missing. Request a new password-reset email.';
    if (button) button.disabled = true;
    return;
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!form.reportValidity()) return;

    const password = document.getElementById('password').value;
    const confirmPassword = document.getElementById('confirmPassword').value;

    if (password !== confirmPassword) {
      msg.textContent = 'Passwords do not match.';
      return;
    }

    if (button) button.disabled = true;
    msg.textContent = 'Updating password...';

    try {
      const response = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ token, password, confirmPassword })
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || 'Password reset failed.');

      msg.replaceChildren();
      msg.append(document.createTextNode((data.message || 'Password changed successfully.') + ' '));
      const link = document.createElement('a');
      link.href = '/login';
      link.textContent = 'Log in';
      msg.append(link);
      form.reset();
    } catch (error) {
      msg.textContent = error.message || 'Could not reset password. Request a new reset link if necessary.';
    } finally {
      if (button) button.disabled = false;
    }
  });
});
