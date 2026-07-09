export function WebFlasher() {
  return (
    <main class="wrap flasher">
      <header class="flasher-head">
        <p class="wordmark">
          Stream<span>Line</span>
        </p>
        <p class="flasher-kicker">USB installer</p>
        <h1>Install a clean device</h1>
        <p class="flasher-intro">
          Connect the board by USB, then install the current firmware. The device starts in Wi-Fi
          setup when installation finishes.
        </p>
      </header>

      <section class="card flasher-install" aria-labelledby="install-heading">
        <p class="eyebrow">1. Install</p>
        <h2 id="install-heading">Connect your board</h2>
        <p class="lead">
          The installer erases the board and writes the full firmware image, including the
          OTA-capable layout.
        </p>
        <esp-web-install-button manifest="./manifest.json">
          <button class="btn primary flasher-activate" slot="activate" type="button">
            Connect &amp; install
          </button>
          <span class="flasher-notice" slot="unsupported">
            Web Serial is unavailable here. Use desktop Chrome, Edge, or Firefox 151 or newer.
          </span>
          <span class="flasher-notice" slot="not-allowed">
            Open this page over HTTPS or on localhost to install a board.
          </span>
        </esp-web-install-button>
        <p class="flasher-hint">Select the board&apos;s USB serial port when the browser asks.</p>
      </section>

      <div class="flasher-grid">
        <section class="card" aria-labelledby="prepare-heading">
          <p class="eyebrow">Before you start</p>
          <h2 id="prepare-heading">Prepare the connection</h2>
          <ul class="flasher-list">
            <li>Use desktop Chrome, Edge, or Firefox 151 or newer.</li>
            <li>Use a data-capable USB cable.</li>
            <li>Install a CP210x or CH340 driver if the serial port is missing.</li>
          </ul>
        </section>

        <section class="card" aria-labelledby="setup-heading">
          <p class="eyebrow">2. Set up Wi-Fi</p>
          <h2 id="setup-heading">Continue on the setup network</h2>
          <ol class="flasher-list">
            <li>
              Join <code>esp32-streamline-XXXX</code> after the board restarts.
            </li>
            <li>
              Open <code>http://192.168.71.1/</code>.
            </li>
            <li>Save the generated admin key, then join your home Wi-Fi.</li>
          </ol>
        </section>
      </div>

      <section class="card flasher-cli" aria-labelledby="terminal-heading">
        <div>
          <p class="eyebrow">Alternative</p>
          <h2 id="terminal-heading">Use the terminal</h2>
          <p class="lead">Download the full image from Releases, then flash it with esptool.</p>
        </div>
        <a class="btn secondary" href="https://github.com/lutyjj/esp32-streamline/releases">
          Open Releases
        </a>
      </section>

      <footer class="flasher-footer">
        <a href="https://github.com/lutyjj/esp32-streamline#readme">Full setup guide</a>
        <span aria-hidden="true">·</span>
        <a href="https://github.com/lutyjj/esp32-streamline">Source on GitHub</a>
      </footer>
    </main>
  );
}
