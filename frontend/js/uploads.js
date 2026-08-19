// STANDALONE DOCUMENT UPLOAD FLOW (Bottom Vault)
// ==============================================================
const vaultUploadBtn = document.getElementById("upload-btn");
const vaultFileInput = document.getElementById("document-upload");
const vaultUploadStatus = document.getElementById("upload-status");
const vaultQueueList = document.getElementById("queue-list");

function renderVaultQueueList() {
  if (!vaultQueueList) return;
  vaultQueueList.innerHTML = "";
  if (vaultFileQueue.length === 0) {
    vaultUploadStatus.innerText = "";
    return;
  }
  vaultUploadStatus.innerText = `Selected ${vaultFileQueue.length} file(s) pending transmission:`;
  vaultFileQueue.forEach((file, index) => {
    const row = document.createElement("div");
    row.className =
      "flex justify-between items-center bg-slate-50 border border-slate-100 rounded-xl px-4 py-2 text-xs font-semibold text-slate-700 transition-all";
    row.innerHTML = `<span class="truncate max-w-[240px]">${file.name} (${(file.size / 1024).toFixed(1)} KB)</span><button type="button" onclick="removeVaultFileFromQueue(${index})" class="text-red-500 hover:text-red-700 hover:underline focus:outline-none">Remove</button>`;
    vaultQueueList.appendChild(row);
  });
}

window.removeVaultFileFromQueue = function (index) {
  vaultFileQueue.splice(index, 1);
  renderVaultQueueList();
};

if (vaultUploadBtn && vaultFileInput && vaultUploadStatus) {
  vaultFileInput.addEventListener("change", () => {
    const selectedFiles = vaultFileInput.files;
    for (let i = 0; i < selectedFiles.length; i++) {
      if (
        !vaultFileQueue.some(
          (q) =>
            q.name === selectedFiles[i].name &&
            q.size === selectedFiles[i].size,
        )
      )
        vaultFileQueue.push(selectedFiles[i]);
    }
    renderVaultQueueList();
    vaultFileInput.value = "";
  });

  vaultUploadBtn.addEventListener("click", async () => {
    if (vaultFileQueue.length === 0) {
      alert("Please choose one or more files to upload first!");
      return;
    }
    const userEmail = localStorage.getItem("user_email");
    if (!userEmail) {
      alert("Session expired.");
      showLogin();
      return;
    }
    vaultUploadBtn.disabled = true;
    try {
      const totalFiles = vaultFileQueue.length;
      for (let i = 0; i < vaultFileQueue.length; i++) {
        const file = vaultFileQueue[i];
        vaultUploadStatus.innerText = `[${i + 1}/${totalFiles}] Requesting secure authorization for ${file.name}...`;
        const authResponse = await fetch(
          "https://85hyx9ie7d.execute-api.ca-central-1.amazonaws.com/prod/Contact",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "getUploadUrl",
              fileName: file.name,
              fileType: file.type,
              userEmail: userEmail,
            }),
          },
        );
        const authResult = await authResponse.json();
        if (!authResponse.ok || authResult.status !== "SUCCESS")
          throw new Error(authResult.message);

        vaultUploadStatus.innerText = `[${i + 1}/${totalFiles}] Transmitting ${file.name} to Vault...`;
        const uploadResponse = await fetch(authResult.uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": file.type },
          body: file,
        });
        if (!uploadResponse.ok) {
          const errTxt = await uploadResponse.text();
          let errMsg = "S3 rejected the file transmission.";
          try {
            const doc = new DOMParser().parseFromString(errTxt, "text/xml");
            const msg = doc.getElementsByTagName("Message")[0];
            if (msg) errMsg = "S3 Error: " + msg.textContent;
          } catch (e) {}
          throw new Error(errMsg);
        }

        vaultUploadStatus.innerText = `[${i + 1}/${totalFiles}] Notifying advisors...`;
        await fetch(
          "https://85hyx9ie7d.execute-api.ca-central-1.amazonaws.com/prod/Contact",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "notifyUploadComplete",
              fileKey: authResult.fileKey,
              userEmail: userEmail,
            }),
          },
        );
      }
      vaultUploadStatus.innerText = `Success! ${totalFiles} files uploaded.`;
      alert(`Successfully stored! Secure email alert dispatched.`);
      vaultFileQueue = [];
      renderVaultQueueList();
    } catch (err) {
      vaultUploadStatus.innerText = "Upload failed. Cloud connection error.";
    } finally {
      vaultUploadBtn.disabled = false;
    }
  });
}
