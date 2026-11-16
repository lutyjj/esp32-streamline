import { Card, CardBody, CardHead, Content, Fact, Facts, TopBar } from 'linen';
import type { StatusResponse } from '../../lib/api';
import type { Handoff as HandoffState } from '../../state/connection';
import { handoffStory } from '../../state/handoff';

/** The device left this browser's network on purpose: where to go next, and how to know it worked. */
export function Handoff({ handoff, last }: { handoff: HandoffState; last: StatusResponse | null }) {
  const story = handoffStory(handoff, last);
  return (
    <>
      <TopBar title={story.title} />
      <Content>
        <Card>
          <CardHead title="What happens now" description={story.text} />
          <CardBody>
            <Facts>
              {story.setupNetwork && (
                <>
                  <Fact
                    name="Setup network"
                    mono
                    copy={{ value: story.setupNetwork.ssid, label: 'Setup network' }}
                  >
                    {story.setupNetwork.ssid}
                  </Fact>
                  <Fact
                    name="Its password"
                    mono
                    copy={{ value: story.setupNetwork.password, label: 'Setup network password' }}
                  >
                    {story.setupNetwork.password}
                  </Fact>
                </>
              )}
              <Fact name="Then open" mono copy={{ value: story.address, label: 'Console address' }}>
                {story.address}
              </Fact>
            </Facts>
          </CardBody>
        </Card>
      </Content>
    </>
  );
}
