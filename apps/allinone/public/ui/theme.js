(() => {
  const key = "allinone:v1:theme";
  const sync = () => {
    let theme;
    try {
      theme = localStorage.getItem(key);
    } catch {
      theme = null;
    }
    document.documentElement.dataset.theme = theme === "dark" || theme === "light" ? theme : "system";
  };
  sync();
  window.addEventListener("storage", (event) => {
    if (event.key === key || event.key === null) sync();
  });
})();
