'use strict';

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('forgotPasswordForm');
  const message = document.getElementById('formMessage');
  const button = form.querySelector('button[type="submit"]');

  form.addEventListener('submit', async event => {
    event.preventDefault();

    if (!form.reportValidity()) return;

    const email = document.getElementById('email').value.trim();

    button.disabled = true;
    button.textContent = 'Submitting...';
    message.textContent = '';

    try {
      const response = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        credentials: 'same-origin',
        body: JSON.stringify({ email })
      });

      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          result.message ||
          'Password recovery is temporarily unavailable. Please try again.'
        );
      }

      message.textContent = result.message ||
        'If an eligible account exists, recovery instructions will be sent to its registered email address.';
      form.reset();
    } catch (error) {
      message.textContent = error.message ||
        'Unable to submit your request. Please try again.';
    } finally {
      button.disabled = false;
      button.textContent = 'Send Reset Instructions';
    }
  });
});
