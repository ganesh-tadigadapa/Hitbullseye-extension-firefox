function toast(message, type = "success") {
    let box = document.getElementById("hb-toasts");
    if (!box) {
        box = document.createElement("div");
        box.id = "hb-toasts";
        box.style.cssText =
            "position:fixed;left:1%;bottom:1%;z-index:2147483647;display:flex;flex-direction:column;gap:6px;max-width:60%;pointer-events:none;";
        document.body.appendChild(box);
    }
    const div = document.createElement("div");
    div.textContent = message;
    div.style.cssText = [
        'font-family:"Segoe UI",Tahoma,Geneva,Verdana,sans-serif',
        "font-size:15px",
        "padding:10px 14px",
        "border-radius:4px",
        "box-shadow:0 0 10px 0 rgba(0,0,0,0.4)",
        "color:#fff",
        "background-color:" + (type === "success" ? "#350054" : "#d00000"),
        "transition:opacity 0.5s ease-in-out",
    ].join(";");
    box.appendChild(div);
    while (box.children.length > 5) box.firstChild.remove();
    setTimeout(() => {
        div.style.opacity = "0";
        setTimeout(() => div.remove(), 500);
    }, type === "success" ? 3000 : 8000);
}
