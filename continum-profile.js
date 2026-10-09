(() => {
  const profileButton = document.querySelector(".prof");
  if (!profileButton) return;

  profileButton.addEventListener("click", () => {
    window.location.assign("login.html");
  });
})();
