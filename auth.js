(() => {
  const signupForm = document.querySelector("#signup-form");
  const loginForm = document.querySelector("#login-form");
  const signupTab = document.querySelector("#signup-tab");
  const loginTab = document.querySelector("#login-tab");
  const formsPanel = document.querySelector("#forms-panel");
  const accountPanel = document.querySelector("#account-panel");
  const accountMessage = document.querySelector("#account-message");
  const formMessage = document.querySelector("#form-message");
  const logoutButton = document.querySelector("#logout-button");

  function showMessage(element, message, kind = "") {
    element.textContent = message;
    element.className = `notice${kind ? ` ${kind}` : ""}`;
  }

  function selectForm(mode) {
    const signup = mode === "signup";
    signupForm.hidden = !signup;
    loginForm.hidden = signup;
    signupTab.classList.toggle("active", signup);
    loginTab.classList.toggle("active", !signup);
    signupTab.setAttribute("aria-pressed", String(signup));
    loginTab.setAttribute("aria-pressed", String(!signup));
    document.querySelector("#page-title").textContent = signup ? "Crie sua conta" : "Boas-vindas de volta";
    showMessage(formMessage, "");
  }

  async function request(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: { "Content-Type": "application/json", ...options.headers },
      credentials: "same-origin",
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Não foi possível concluir sua solicitação.");
    return result;
  }

  async function submitForm(form, endpoint, values, button) {
    button.disabled = true;
    showMessage(formMessage, "Aguarde...");
    try {
      await request(endpoint, { method: "POST", body: JSON.stringify(values) });
      window.location.assign("index.html");
    } catch (error) {
      showMessage(formMessage, error.message, "error");
      button.disabled = false;
    }
  }

  signupTab.addEventListener("click", () => selectForm("signup"));
  loginTab.addEventListener("click", () => selectForm("login"));

  signupForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(signupForm);
    const button = signupForm.querySelector("button[type=submit]");
    void submitForm(signupForm, "/api/register", {
      email: data.get("email"),
      username: data.get("username"),
      password: data.get("password"),
    }, button);
  });

  loginForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(loginForm);
    const button = loginForm.querySelector("button[type=submit]");
    void submitForm(loginForm, "/api/login", {
      identifier: data.get("identifier"),
      password: data.get("password"),
    }, button);
  });

  logoutButton.addEventListener("click", async () => {
    logoutButton.disabled = true;
    try {
      await request("/api/logout", { method: "POST", body: "{}" });
      accountPanel.hidden = true;
      formsPanel.hidden = false;
      selectForm("login");
      showMessage(formMessage, "Você saiu da sua conta.", "success");
    } catch (error) {
      showMessage(accountMessage, error.message, "error");
      logoutButton.disabled = false;
    }
  });

  void request("/api/session")
    .then((result) => {
      if (!result.authenticated) return;
      formsPanel.hidden = true;
      accountPanel.hidden = false;
      showMessage(accountMessage, `Você está conectado como ${result.user.username}.`, "success");
    })
    .catch((error) => showMessage(formMessage, error.message, "error"));
})();
