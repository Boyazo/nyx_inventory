/* Runs independently of app imports so a failed dependency leaves a retry screen. */
(() => {
  const screen = document.getElementById("startup-screen");
  const message = document.getElementById("startup-message");
  const retry = document.getElementById("startup-retry");
  let finished = false;
  const timeout = setTimeout(() => fail("This is taking longer than expected. Check your connection and try again."), 20000);
  function fail(text) {
    if (finished) return;
    clearTimeout(timeout);
    screen.classList.add("is-error");
    screen.setAttribute("aria-busy", "false");
    message.textContent = text;
    retry.hidden = false;
  }
  function finish() {
    finished = true;
    clearTimeout(timeout);
    screen.hidden = true;
    screen.setAttribute("aria-busy", "false");
    document.body.classList.remove("is-loading");
  }
  retry.addEventListener("click", () => window.location.reload());
  window.nyxStartup = { finish, fail };
})();
