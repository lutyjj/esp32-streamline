import {
  Button,
  Card,
  CardBody,
  CardHead,
  Content,
  classes,
  Fact,
  Facts,
  LINK_CLASS,
  LinenProvider,
  Notice,
  SCREEN_TITLE_CLASS,
} from 'linen';
import icon from '../icon.svg';
import { SETUP_ADDRESS } from '../shared/setupNetwork';

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      /** esp-web-tools' install button, which main.tsx defines. */
      'esp-web-install-button': HTMLAttributes<HTMLElement> & { manifest: string };
    }
  }
}

const REPOSITORY = 'https://github.com/lutyjj/esp32-streamline';

/** The installer: what StreamLine is, the install itself, and the setup that follows it. */
export function FlasherPage() {
  return (
    <LinenProvider>
      <main>
        <Content className="grid max-w-3xl gap-4 md:py-10">
          <header className="grid gap-2 pb-2">
            <h1 className={classes('flex items-center gap-2', SCREEN_TITLE_CLASS)}>
              <img src={icon} alt="" className="size-6" />
              Install StreamLine
            </h1>
            <p className="max-w-prose text-text-secondary">
              StreamLine turns an ESP32 audio board into a network source for a turntable or CD
              deck. This page writes its firmware to the board over USB.
            </p>
          </header>
          <Install />
          <SetUp />
          <footer className="text-sm text-text-muted">
            <a className={LINK_CLASS} href={REPOSITORY}>
              StreamLine on GitHub
            </a>
          </footer>
        </Content>
      </main>
    </LinenProvider>
  );
}

function Install() {
  return (
    <Card>
      <CardHead
        title="Install the firmware"
        description="Installing erases the board and writes the latest release. Choose the board's serial port when the browser asks."
      />
      <CardBody className="grid gap-4">
        <Facts>
          <Fact name="Board">ESP32 audio board, 4 MB of flash, chip revision 3.0 or later</Fact>
          <Fact name="Cable">USB, one that carries data</Fact>
          <Fact name="Browser">Chrome, Edge, or Firefox 151 or later, on a computer</Fact>
          <Fact name="Serial driver">CP210x or CH340, if no port appears</Fact>
        </Facts>
        <esp-web-install-button manifest="./manifest.json" className="block">
          <Button slot="activate" variant="primary">
            Connect &amp; install
          </Button>
          <div slot="unsupported">
            <Notice
              tone="warn"
              title="This browser cannot reach the board's USB port."
              description="Open this page on a computer, in Chrome, Edge, or Firefox 151 or later."
            />
          </div>
          <div slot="not-allowed">
            <Notice
              tone="warn"
              title="This page cannot install over an insecure connection."
              description="Open it over HTTPS, or from localhost."
            />
          </div>
        </esp-web-install-button>
        <p className="text-sm text-text-secondary">
          Prefer a terminal? Download the full image from{' '}
          <a className={LINK_CLASS} href={`${REPOSITORY}/releases/latest`}>
            Releases
          </a>{' '}
          and write it with esptool, as the{' '}
          <a className={LINK_CLASS} href={`${REPOSITORY}#1-flash-the-board`}>
            quick start
          </a>{' '}
          shows.
        </p>
      </CardBody>
    </Card>
  );
}

/** Stage 1 of the journey after the install: the setup network and its console. */
function SetUp() {
  return (
    <Card>
      <CardHead
        title="Set up the device"
        description="The board starts a Wi-Fi network of its own, where its console sets it up."
      />
      <CardBody className="grid gap-3 text-sm">
        <ol className="grid list-decimal gap-2 pl-5">
          <li>
            In the installer, choose Next, then Logs &amp; Console, then Reset Device. As the board
            starts, it prints its setup network,{' '}
            <span className="font-mono">esp32-streamline-…</span>, and its new password: the install
            replaces any password on the board's label.
          </li>
          <li>
            Join that network from a phone or computer. Its console opens by itself, or at{' '}
            <span className="font-mono">{SETUP_ADDRESS}</span>.
          </li>
          <li>Choose your Wi-Fi and keep the admin key the console makes.</li>
        </ol>
        <p className="text-text-secondary">
          No password? Hold the board's first button (KEY1 on the ESP32 Audio Kit) while you plug it
          in, and the setup network opens without one for that start.
        </p>
      </CardBody>
    </Card>
  );
}
