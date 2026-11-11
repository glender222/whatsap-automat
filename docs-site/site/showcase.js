(() => {
  "use strict";

  const root = document.documentElement;
  const header = document.querySelector(".site-header");
  const menu = document.querySelector(".menu-toggle");
  const navigation = document.getElementById("primary-nav");
  const motionButton = document.querySelector(".motion-toggle");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let motionPaused = false;

  try {
    const saved = localStorage.getItem("whatsap-showcase-motion");
    if (saved !== null) motionPaused = saved === "paused";
  } catch {
    /* Browser preferences still apply when storage is unavailable. */
  }

  function renderMotionPreference() {
    const paused = motionPaused || reducedMotion.matches;
    root.classList.toggle("motion-off", paused);
    motionButton.setAttribute("aria-pressed", String(paused));
    motionButton.disabled = reducedMotion.matches;
    motionButton.lastElementChild.textContent = reducedMotion.matches
      ? "Movimiento reducido del sistema"
      : motionPaused
        ? "Animaciones pausadas"
        : "Animaciones activadas";
  }

  motionButton.hidden = false;
  renderMotionPreference();
  motionButton.addEventListener("click", () => {
    motionPaused = !motionPaused;
    renderMotionPreference();
    try {
      localStorage.setItem(
        "whatsap-showcase-motion",
        motionPaused ? "paused" : "playing",
      );
    } catch {
      /* The current page still respects the selected preference. */
    }
  });
  reducedMotion.addEventListener("change", renderMotionPreference);

  function closeMenu(restoreFocus = false) {
    menu.setAttribute("aria-expanded", "false");
    menu.setAttribute("aria-label", "Abrir menú");
    navigation.classList.remove("open");
    if (restoreFocus) menu.focus();
  }

  menu.hidden = false;
  menu.addEventListener("click", () => {
    const open = menu.getAttribute("aria-expanded") !== "true";
    menu.setAttribute("aria-expanded", String(open));
    menu.setAttribute("aria-label", open ? "Cerrar menú" : "Abrir menú");
    navigation.classList.toggle("open", open);
  });
  navigation.addEventListener("click", (event) => {
    if (event.target.closest("a")) closeMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && menu.getAttribute("aria-expanded") === "true")
      closeMenu(true);
  });
  document.addEventListener("click", (event) => {
    if (!header.contains(event.target)) closeMenu();
  });
  root.classList.add("js");

  function wireTabGroup(tabs, activate) {
    tabs.forEach((tab, index) => {
      tab.addEventListener("click", () => activate(tab));
      tab.addEventListener("keydown", (event) => {
        let nextIndex;
        if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
        if (event.key === "ArrowLeft")
          nextIndex = (index - 1 + tabs.length) % tabs.length;
        if (event.key === "Home") nextIndex = 0;
        if (event.key === "End") nextIndex = tabs.length - 1;
        if (nextIndex === undefined) return;
        event.preventDefault();
        tabs[nextIndex].focus();
        activate(tabs[nextIndex]);
      });
    });
  }

  const productTabs = [...document.querySelectorAll("[data-product-tab]")];
  wireTabGroup(productTabs, (selected) => {
    productTabs.forEach((tab) => {
      const active = tab === selected;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      const panel = document.getElementById(tab.getAttribute("aria-controls"));
      panel.hidden = !active;
      panel.classList.toggle("panel-enter", active);
    });
  });

  const modes = {
    suggest: {
      title: "La IA propone. Tu equipo responde.",
      description:
        "Consulta el catálogo y prepara una sugerencia. La persona la revisa y decide qué enviar.",
      label: "Sugerencia para el equipo",
      reply: "«Sí, tenemos disponibilidad. Te ayudo con el pedido.»",
      footnote: "La decisión final queda en manos de tu equipo.",
      accessibleLabel: "Ejemplo ilustrativo de atención asistida",
    },
    auto: {
      title: "Una respuesta dentro de tus reglas.",
      description:
        "La revisión publicada puede responder consultas autorizadas. Los permisos y el estado de la conversación se comprueban antes del envío.",
      label: "Respuesta automática autorizada",
      reply: "«Sí, tenemos disponibilidad. ¿Qué cantidad necesitas?»",
      footnote: "Requiere modo automático y una revisión vinculada a WhatsApp.",
      accessibleLabel: "Ejemplo ilustrativo de atención automática",
    },
  };
  const modeButtons = [...document.querySelectorAll("[data-mode]")];
  modeButtons.forEach((button) =>
    button.addEventListener("click", () => {
      const mode = modes[button.dataset.mode];
      modeButtons.forEach((item) =>
        item.setAttribute("aria-pressed", String(item === button)),
      );
      document.getElementById("mode-title").textContent = mode.title;
      document.getElementById("mode-description").textContent =
        mode.description;
      document.getElementById("flow-result-label").textContent = mode.label;
      document.getElementById("flow-result-text").textContent = mode.reply;
      document.getElementById("flow-footnote").textContent = mode.footnote;
      document
        .querySelector(".flow-demo")
        .setAttribute("aria-label", mode.accessibleLabel);
    }),
  );

  const examples = {
    typescript:
      "import { AutomatClient } from '@whatsap-automat/sdk';\n\nconst automat = new AutomatClient({\n  baseUrl: 'https://tu-servidor.example/api/v1',\n  token: process.env.AUTOMAT_TOKEN,\n});\n\nconst conversation = await automat.conversations.get('42');\n\nconsole.log(conversation.status);",
    python:
      "import os\nfrom whatsap_automat_sdk import AutomatClient\n\nautomat = AutomatClient(\n    base_url='https://tu-servidor.example/api/v1',\n    token=os.environ['AUTOMAT_TOKEN'],\n)\n\nconversation = automat.conversations.get('42')\nprint(conversation.status)",
    curl: "# Usa el token de sesión de tu propia instancia.\ncurl --request GET \\\n  'https://tu-servidor.example/api/v1/conversations/42' \\\n  --header \"Authorization: Bearer $AUTOMAT_TOKEN\" \\\n  --header 'Accept: application/json'",
  };
  const codeTabs = [...document.querySelectorAll("[data-code-tab]")];
  const code = document.getElementById("code-example");
  const codePanel = document.getElementById("integration-code");
  const copyFeedback = document.querySelector(".copy-feedback");
  wireTabGroup(codeTabs, (selected) => {
    codeTabs.forEach((tab) => {
      const active = tab === selected;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    code.textContent = examples[selected.dataset.codeTab];
    codePanel.setAttribute("aria-labelledby", selected.id);
    copyFeedback.textContent = "";
  });

  let copyReset;
  document.querySelector(".copy-code").addEventListener("click", async () => {
    clearTimeout(copyReset);
    try {
      await navigator.clipboard.writeText(code.textContent);
      copyFeedback.textContent = "Copiado";
    } catch {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(code);
      selection.removeAllRanges();
      selection.addRange(range);
      copyFeedback.textContent = "Seleccionado · Ctrl+C o ⌘C";
    }
    copyReset = setTimeout(() => {
      copyFeedback.textContent = "";
    }, 2500);
  });

  if ("IntersectionObserver" in window) {
    const reveal = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("visible");
          reveal.unobserve(entry.target);
        });
      },
      { threshold: 0.08 },
    );
    document
      .querySelectorAll(".reveal")
      .forEach((element) => reveal.observe(element));
    root.classList.add("motion-ready");
  }

  let scrollFrame;
  function updateScroll() {
    scrollFrame = undefined;
    const distance = document.documentElement.scrollHeight - innerHeight;
    root.style.setProperty(
      "--scroll-progress",
      distance > 0 ? String(scrollY / distance) : "0",
    );
    header.classList.toggle("scrolled", scrollY > 12);
  }
  window.addEventListener(
    "scroll",
    () => {
      if (scrollFrame === undefined)
        scrollFrame = requestAnimationFrame(updateScroll);
    },
    { passive: true },
  );
  updateScroll();

  const heroArt = document.querySelector(".hero-art");
  if (window.matchMedia("(pointer: fine)").matches) {
    let pointerFrame;
    heroArt.addEventListener("pointermove", (event) => {
      if (motionPaused || reducedMotion.matches || pointerFrame !== undefined)
        return;
      pointerFrame = requestAnimationFrame(() => {
        const bounds = heroArt.getBoundingClientRect();
        const x = (event.clientX - bounds.left) / bounds.width - 0.5;
        const y = (event.clientY - bounds.top) / bounds.height - 0.5;
        heroArt.style.setProperty("--art-x", `${x * 14}px`);
        heroArt.style.setProperty("--art-y", `${y * 10}px`);
        heroArt.style.setProperty("--art-rotate", `${x * 5 - 3}deg`);
        pointerFrame = undefined;
      });
    });
    heroArt.addEventListener("pointerleave", () => {
      heroArt.style.setProperty("--art-x", "0px");
      heroArt.style.setProperty("--art-y", "0px");
      heroArt.style.setProperty("--art-rotate", "-3deg");
    });
  }
})();
