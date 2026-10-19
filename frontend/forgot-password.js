'use strict';

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('forgotPasswordForm');
  const message = document.getElementById('formMessage');
  if (!form || !message) return;

  const button = form.querySelector('button[type="submit"]');
  if (!button) return;

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!form.reportValidity()) return;

    const email = document.getElementById('email')?.value.trim();
    if (!email) {
      message.textContent = 'Enter your registered email address.';
      return;
    }

    button.disabled = true;
    button.textContent = 'Sending...';
    message.textContent = 'Submitting your request...';

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
          result.message || 'Unable to submit the request. Please try again.'
        );
      }

      message.textContent = result.message ||
        'If an eligible account exists, password-reset instructions will be sent by email.';
      form.reset();
    } catch (error) {
      message.textContent =
        error.message || 'Unable to submit your request. Please try again.';
    } finally {
      button.disabled = false;
      button.textContent = 'Send Reset Instructions';
    }
  });
});
