'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const chat = $('chat');
  const form = $('chat-form');
  const input = $('message');
  const language = $('language');
  const notice = $('notice');

  const guides = {
    register: {
      title: 'Create an account',
      steps: [
        'Open the registration page using the Home page or the Register link.',
        'Enter the requested information accurately and select your location and preferred language where requested.',
        'Review the information and submit the registration form.',
        'If email verification is required, open the verification message sent to your email and follow its instructions.'
      ],
      link: '/register'
    },
    login: {
      title: 'Login and account access',
      steps: [
        'Open the login page.',
        'Enter the email address and password you registered with.',
        'Submit the login form.',
        'If you cannot remember your password, use the Forgot Password option. Never share your password with anyone.'
      ],
      link: '/login'
    },
    verification: {
      title: 'Verify your email',
      steps: [
        'Open the email account you used to register.',
        'Look for the Baba Go Again verification email, including your spam or junk folder.',
        'Open the message and use its verification link before it expires.',
        'If the link has expired, return to the app and request a new verification link if that option is available.'
      ],
      link: '/login'
    },
    profile: {
      title: 'Manage your profile',
      steps: [
        'Sign in to Baba Go Again.',
        'Open your account or profile area.',
        'Look for the available edit-profile and profile-photo controls.',
        'Review your changes before saving. The exact controls depend on the profile features enabled in your account.'
      ],
      link: '/'
    },
    audio: {
      title: 'Upload audio',
      steps: [
        'Sign in and open Audio & Video.',
        'Look for the audio upload or publishing option.',
        'Select an audio file using your device file picker and complete any required title or description fields.',
        'Review the details and submit. Wait for a success confirmation before assuming the audio is published.'
      ],
      link: '/media'
    },
    video: {
      title: 'Upload video',
      steps: [
        'Sign in and open Audio & Video.',
        'Choose the video upload or publishing option if available.',
        'Select your video and complete any required details.',
        'Submit the upload and wait for the application to confirm success. Upload size and format restrictions may apply.'
      ],
      link: '/media'
    },
    community: {
      title: 'Use the community',
      steps: [
        'Open Community.',
        'Explore the available community feed, groups, and events.',
        'Use the available controls to publish a post, comment, join a group, or participate in an event.',
        'Follow the community rules and avoid posting private information.'
      ],
      link: '/community'
    },
    messages: {
      title: 'Send messages',
      steps: [
        'Sign in to your account.',
        'Open Messages.',
        'Choose an available conversation or use the available option to start one.',
        'Write your message and send it. Only share information you are comfortable sending to the recipient.'
      ],
      link: '/messages'
    },
    'public-figures': {
      title: 'Explore public figures',
      steps: [
        'Open Public Figures from the main navigation.',
        'Browse the profiles and information displayed.',
        'Open a profile to review the available details and actions.',
        'Check the source and date of important claims before treating them as verified.'
      ],
      link: '/public-figures'
    },
    wallet: {
      title: 'Understand your wallet',
      steps: [
        'Sign in and open Wallet.',
        'Review the wallet information and the actions currently available to your account.',
        'Read the requirements and any fees or processing details before requesting a payout.',
        'Never disclose your PIN, password, or banking credentials to the AI guide. Confirm transactions through the application itself.'
      ],
      link: '/wallet'
    },
    location: {
      title: 'Find a polling unit',
      steps: [
        'Open the location or polling-unit feature in Baba Go Again.',
        'Choose a state from the available list.',
        'Select the relevant local government area, ward, and polling unit in sequence.',
        'Confirm the displayed details against official election information when making voting arrangements.'
      ],
      link: '/'
    },
    security: {
      title: 'Protect your account',
      steps: [
        'Use a unique, strong password and keep it private.',
        'Never share verification codes, password-reset links, or account session information.',
        'Avoid opening suspicious messages or links.',
        'If you suspect someone has accessed your account, use the official account recovery process and contact the application support team.'
      ],
      link: '/login'
    }
  };

  function addBubble(text, who = 'assistant') {
    const bubble = document.createElement('div');
    bubble.className = `bubble ${who}`;
    bubble.textContent = text;
    chat.appendChild(bubble);
    chat.scrollTop = chat.scrollHeight;
    return bubble;
  }

  function speak(text) {
    if (!('speechSynthesis' in window)) {
      notice.textContent = 'Speech playback is not supported in this browser. You can still read the guide.';
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = language.value;
    utterance.rate = 0.95;
    window.speechSynthesis.speak(utterance);
  }

  function showGuide(key) {
    const guide = guides[key];
    if (!guide) return;

    const answer = `${guide.title}\n\n${guide.steps.map((step, i) => `${i + 1}. ${step}`).join('\n\n')}\n\nOpen the relevant page: ${guide.link}`;
    addBubble(answer);
    speak(answer.replace(guide.link, 'Use the page link shown below to continue.'));

    const link = document.createElement('a');
    link.href = guide.link;
    link.textContent = `Open ${guide.title}`;
    link.className = 'bubble assistant';
    link.style.display = 'block';
    link.style.color = '#084c9c';
    link.style.fontWeight = '700';
    link.style.textDecoration = 'none';
    chat.appendChild(link);
    chat.scrollTop = chat.scrollHeight;
  }

  function findTopic(text) {
    const q = text.toLowerCase();
    const rules = [
      ['verification', /verif|verify email|confirmation email/],
      ['register', /register|registration|sign up|create account/],
      ['login', /log ?in|sign ?in|password|forgot password/],
      ['audio', /audio|music|sound recording/],
      ['video', /video|film|clip|recording/],
      ['community', /community|group|post|comment|event/],
      ['messages', /message|chat with user|send a text/],
      ['public-figures', /public figure|politician profile/],
      ['wallet', /wallet|payout|withdraw/],
      ['location', /polling unit|ward|local government|\\blga\\b|location/],
      ['profile', /profile|photo|picture/],
      ['security', /security|scam|hacked|protect account/]
    ];
    return rules.find(([, pattern]) => pattern.test(q))?.[0] || null;
  }

  /* BGA_FREE_VOICE_ASSISTANT_V1 */
  const localAnswers = [
    {
      keys: ['hello', 'hi', 'good morning', 'good afternoon', 'good evening', 'greetings'],
      answer: 'Hello! Welcome to Baba Go Again. I am your free voice assistant. You can ask me how to use the application, or select a feature above for step-by-step guidance.'
    },
    {
      keys: ['who are you', 'what are you', 'your name', 'introduce yourself'],
      answer: 'I am the Baba Go Again Voice Assistant. I use prepared answers and your browser voice features to help you navigate the application. I cannot independently access your private account or perform actions for you.'
    },
    {
      keys: ['what can you do', 'help me', 'help', 'how do you work', 'what can i ask'],
      answer: 'I can guide you through registration, login, email verification, profiles, audio and video uploads, community, messages, public figures, wallet safety, polling-unit information, and account security. Choose a feature button or ask a question about one of these topics.'
    },
    {
      keys: ['create account', 'register', 'registration', 'sign up'],
      answer: 'To register, open the Register page, enter the requested information, review it, and submit the form. If email verification is required, open the verification message and follow its instructions. Never share your password or verification code with me.'
    },
    {
      keys: ['verify email', 'email verification', 'verification link', 'confirmation email'],
      answer: 'To verify your email, open the email account you used to register. Look for the Baba Go Again verification message, including your spam folder. Open its link before it expires. If it has expired, return to the application and request another link if that option is available.'
    },
    {
      keys: ['forgot password', 'reset password', 'cannot log in', 'cannot login'],
      answer: 'Open the login page and look for Forgot Password. Follow the official recovery instructions sent by the application. Never give your password, one-time code, or password-reset link to another person or to this assistant.'
    },
    {
      keys: ['upload audio', 'upload music', 'publish audio', 'audio upload'],
      answer: 'Sign in and open Audio and Video. Find the audio upload option, select your file, enter any required details, and submit it. Wait for the application to confirm success before assuming it has been published.'
    },
    {
      keys: ['upload video', 'publish video', 'video upload'],
      answer: 'Sign in and open Audio and Video. Select the video upload option if available, choose your file, complete the required details, and submit it. Follow any file-size and format limits, and wait for confirmation.'
    },
    {
      keys: ['community', 'groups', 'community post', 'comment', 'events'],
      answer: 'Open Community to explore its available feed, groups, and events. Use the controls provided by the application to post, comment, join groups, or participate in events. Avoid publishing private information.'
    },
    {
      keys: ['send message', 'messages', 'chat with someone', 'private message'],
      answer: 'Sign in and open Messages. Select an existing conversation or use the available option to start one. Write your message and send it. Only share information you are comfortable sending to that recipient.'
    },
    {
      keys: ['public figures', 'politician profile', 'public figure'],
      answer: 'Open Public Figures from the application navigation. Browse the available profiles and review the information shown. Check the source and date of important claims before treating them as verified.'
    },
    {
      keys: ['wallet', 'withdraw money', 'payout', 'withdrawal'],
      answer: 'Sign in and open Wallet to review the information and actions available to your account. Check fees and requirements before requesting a payout. Never share your banking PIN, password, or financial credentials with this assistant.'
    },
    {
      keys: ['polling unit', 'polling-unit', 'ward', 'local government', 'lga', 'election location'],
      answer: 'Open the polling-unit or location feature. Select the available state, local government area, ward, and polling unit as requested. Check the result against official election information. I cannot independently confirm that a polling-unit record is current.'
    },
    {
      keys: ['security', 'scam', 'hacked', 'protect my account'],
      answer: 'Use a unique password and keep it private. Never share verification codes, reset links, or session details. Avoid suspicious links. If you suspect your account has been compromised, use the official recovery process and contact application support.'
    },
    {
      keys: ['languages', 'speak hausa', 'speak yoruba', 'speak igbo', 'nigerian pidgin'],
      answer: 'Use the language selector to choose an available language. Actual speech recognition and spoken voice depend on the languages and voices supported by your browser and device. Language selection alone does not guarantee accurate translation or recognition.'
    },
    {
      keys: ['are you human', 'real person', 'are you a real ai', 'are you intelligent'],
      answer: 'I am a software assistant, not a human. This free version matches questions to prepared answers and uses browser speech features. It does not have unrestricted generative reasoning or independent access to your account.'
    },
    {
      keys: ['thank you', 'thanks'],
      answer: 'You are welcome! Choose a feature above or ask another question about using Baba Go Again.'
    }
  ];

  function findLocalAnswer(text) {
    const q = String(text || '').toLowerCase()
      .replace(/[’']/g, '')
      .replace(/[^a-z0-9\s-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!q) return null;

    const match = localAnswers.find(item =>
      item.keys.some(key => {
        const normalized = key.toLowerCase();
        return q === normalized ||
          q.includes(normalized) ||
          normalized.includes(q) && q.length >= 5;
      })
    );

    return match ? match.answer : null;
  }

  function submitQuestion(text) {
    const question = String(text || '').trim();
    if (!question) return;

    addBubble(question, 'user');
    input.value = '';

    const topic = findTopic(question);
    if (topic) {
      showGuide(topic);
      return;
    }

    const answer = findLocalAnswer(question);

    if (answer) {
      addBubble(answer);
      speak(answer);
      return;
    }

    const fallback =
      'I do not have a prepared answer for that question yet. I can guide you through registration, login, email verification, profiles, audio and video uploads, community, messages, public figures, wallet safety, polling units, and account security. Select a feature above or ask about one of these topics.';

    addBubble(fallback);
    speak(fallback);
  }
  document.querySelectorAll('[data-topic]').forEach(button => {
    button.addEventListener('click', () => showGuide(button.dataset.topic));
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    await submitQuestion(input.value);
  });

  let recognition = null;
  const listenButton = $('listen');

  if ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new SpeechRecognition();
    recognition.interimResults = false;
    recognition.continuous = false;

    recognition.onstart = () => {
      listenButton.textContent = '🎙️ Listening...';
      notice.textContent = 'Speak now. Your browser is capturing speech for transcription.';
    };

    recognition.onresult = event => {
      const transcript = event.results[0][0].transcript;
      input.value = transcript;
      submitQuestion(transcript);
    };

    recognition.onerror = () => {
      notice.textContent = 'Voice input was unavailable or permission was denied. You can type your question instead.';
    };

    recognition.onend = () => {
      listenButton.textContent = '🎙️ Speak to me';
    };

    listenButton.addEventListener('click', () => {
      recognition.lang = language.value;
      try {
        recognition.start();
      } catch {
        notice.textContent = 'Voice input is already active. Please wait a moment and try again.';
      }
    });
  } else {
    listenButton.addEventListener('click', () => {
      notice.textContent = 'Voice input is not supported by this browser. Try a browser that supports speech recognition, or type your question.';
    });
  }

  $('stop').addEventListener('click', () => {
    if (recognition) recognition.stop();
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    listenButton.textContent = '🎙️ Speak to me';
  });
})();
