/**
 * Interactive Landing Page Logic
 * Handles tab switches and code copy actions
 */

// --- Switch Setup Method Tabs ---
function switchTab(method) {
  // Grab buttons
  const hotspotBtn = document.getElementById('tab-hotspot-btn');
  const routerBtn = document.getElementById('tab-router-btn');
  
  // Grab content areas
  const hotspotContent = document.getElementById('tab-content-hotspot');
  const routerContent = document.getElementById('tab-content-router');
  
  if (method === 'hotspot') {
    // Activate Hotspot tab
    hotspotBtn.classList.add('active');
    routerBtn.classList.remove('active');
    
    // Toggle content
    hotspotContent.classList.add('active');
    routerContent.classList.remove('active');
  } else if (method === 'router') {
    // Activate Router tab
    routerBtn.classList.add('active');
    hotspotBtn.classList.remove('active');
    
    // Toggle content
    routerContent.classList.add('active');
    hotspotContent.classList.remove('active');
  }
}

// --- Copy Terminal Commands ---
function copyCode(codeElementId, buttonElementId) {
  const codeText = document.getElementById(codeElementId).innerText;
  const copyBtn = document.getElementById(buttonElementId);
  
  navigator.clipboard.writeText(codeText)
    .then(() => {
      // Visual Feedback
      const originalText = copyBtn.innerText;
      copyBtn.innerText = 'COPIED!';
      copyBtn.style.color = '#10b981'; // Turn green
      
      // Reset
      setTimeout(() => {
        copyBtn.innerText = originalText;
        copyBtn.style.color = ''; // Reset CSS styling
      }, 1500);
    })
    .catch((err) => {
      console.error('Failed to copy text: ', err);
    });
}
