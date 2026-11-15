
      const goatcounterScriptPre = document.createElement('script');
      goatcounterScriptPre.textContent = `
        window.goatcounter = { no_onload: true };
      `;
      document.head.appendChild(goatcounterScriptPre);

      const endpoint = "https://judzos.goatcounter.com/count";
      const goatcounterScript = document.createElement('script');
      goatcounterScript.src = "https://gc.zgo.at/count.js";
      goatcounterScript.defer = true;
      goatcounterScript.setAttribute('data-goatcounter', endpoint);
      goatcounterScript.onload = () => {
        window.goatcounter.endpoint = endpoint;
        goatcounter.count({ path: location.pathname });
        document.addEventListener('nav', () => {
          goatcounter.count({ path: location.pathname });
        });
      };

      document.head.appendChild(goatcounterScript);
    