'use strict';

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('loginForm');
  if (!form) return;

  const emailInput = document.getElementById('email');
  const passwordInput = document.getElementById('password');
  const message = document.getElementById('formMessage');
  const button = form.querySelector('button[type="submit"]');
  const resendButton = document.getElementById('resendVerificationButton');
  const verificationMessage = document.getElementById('verificationMessage');

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!form.reportValidity()) return;

    button.disabled = true;
    button.textContent = 'Signing in...';
    message.textContent = '';

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          email: emailInput.value.trim(),
          password: passwordInput.value
        })
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (data.code === 'VERIFICATION_REQUIRED') {
          message.textContent = 'Your account exists but is not verified. Do not register again. Enter your email above and select Resend Verification Email below.';
          if (verificationMessage) {
            verificationMessage.textContent = 'If email delivery fails, your account remains saved. Please try again when email service is available.';
          }
          if (emailInput) emailInput.focus();
          return;
        }
        throw new Error(data.message || 'Unable to log in.');
      }

      message.textContent =
        'Login successful. Welcome, ' + (data.user?.name || 'member') + '.';

      window.location.href = '/community';
    } catch (error) {
      message.textContent = error.message || 'Login failed.';
    } finally {
      button.disabled = false;
      button.textContent = 'Log In';
    }
  });

  if (resendButton) {
    resendButton.addEventListener('click', async () => {
      const email = emailInput.value.trim();

      if (!email || !emailInput.checkValidity()) {
        verificationMessage.textContent =
          'Enter your registered email address first.';
        emailInput.focus();
        return;
      }

      resendButton.disabled = true;
      verificationMessage.textContent = 'Requesting verification email...';

      try {
        const response = await fetch('/api/auth/resend-verification', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify({ email })
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
          throw new Error(data.message || 'Could not request verification email.');
        }

        verificationMessage.textContent =
          data.message || 'If your account needs verification, instructions will be sent.';
      } catch (error) {
        verificationMessage.textContent =
          (error.message || 'Could not request verification email.') +
          ' Your account is still saved; do not register again. You can retry later.';
      } finally {
        resendButton.disabled = false;
      }
    });
  }
});
