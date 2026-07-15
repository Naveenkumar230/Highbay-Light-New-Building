// NOTE: this check runs entirely in the browser, so it only keeps out
// casual visitors -- anyone opening dev tools can read the credentials
// below or flip the "signed in" flag directly. For anything reachable
// outside a trusted local network, replace this with a real server-side
// login endpoint that verifies credentials and issues a session cookie.
const VALID_EMAIL = 'highbaylight@ctl-india.com';
const VALID_PASSWORD = 'light@1234';
const AUTH_KEY = 'aipl-auth';

// already signed in? skip straight to the app
if (localStorage.getItem(AUTH_KEY) === 'true') {
  window.location.replace('index.html');
}

const form = document.getElementById('loginForm');
const card = document.querySelector('.login-card');
const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('password');
const errorEl = document.getElementById('loginError');
const submitBtn = document.getElementById('loginSubmit');
const pwToggle = document.getElementById('pwToggle');

pwToggle.addEventListener('click', () => {
  const isPw = passwordInput.type === 'password';
  passwordInput.type = isPw ? 'text' : 'password';
  pwToggle.setAttribute('aria-label', isPw ? 'Hide password' : 'Show password');
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  errorEl.textContent = '';

  const email = emailInput.value.trim().toLowerCase();
  const password = passwordInput.value;

  submitBtn.disabled = true;

  // tiny delay so the button feedback registers before redirect/error
  setTimeout(() => {
    if (email === VALID_EMAIL && password === VALID_PASSWORD) {
      localStorage.setItem(AUTH_KEY, 'true');
      window.location.replace('index.html');
      return;
    }

    submitBtn.disabled = false;
    errorEl.textContent = 'Incorrect email or password.';
    card.classList.remove('shake');
    // restart the animation
    void card.offsetWidth;
    card.classList.add('shake');
    passwordInput.value = '';
    passwordInput.focus();
  }, 150);
});