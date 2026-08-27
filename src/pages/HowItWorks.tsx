import { AppNav } from "@/components/AppNav";

/**
 * Plain-language help. Deliberately avoids the internal vocabulary (beats,
 * candidates, grounding, harvest) — someone opening this wants clips, not a
 * tour of the pipeline.
 */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-10 first:mt-0">
      <h2 className="font-brand text-lg font-semibold text-zinc-100">{title}</h2>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-zinc-400">{children}</div>
    </section>
  );
}

function Row({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
      <p className="text-sm font-semibold text-zinc-200">{term}</p>
      <p className="mt-1.5 text-sm leading-relaxed text-zinc-400">{children}</p>
    </div>
  );
}

export function HowItWorks() {
  return (
    <div className="flex h-full flex-col bg-[#0B0D0C]">
      <AppNav active="help" />
      <main className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto px-5 py-10">
        <h1 className="font-brand text-2xl font-semibold text-white">How Cut IQ works</h1>
        <p className="mt-2 text-sm leading-relaxed text-zinc-400">
          Cut IQ finds moments inside long videos and turns them into clips you can use. There are two
          ways in: let it search for you, or cut by hand.
        </p>

        <Section title="Two ways to make clips">
          <div className="grid gap-3">
            <Row term="Find Clips — let it search">
              You tell it who you want clips of. It looks through video captions to find the moments
              where that person shows up, then cuts those moments out for you to review. Best when you
              have a lot of footage and do not want to scrub through it.
            </Row>
            <Row term="Manual Clip Studio — cut it yourself">
              You load one video, read along with the transcript, and mark the start and end of each
              clip yourself. Best when you know exactly what you want.
            </Row>
          </div>
        </Section>

        <Section title="Starting a search">
          <p>Find Clips asks for four things. Only the first three are required.</p>
          <div className="grid gap-3">
            <Row term="Player / subject">
              Who the clips should be about. Use the name the way commentators say it out loud, since
              that is what Cut IQ is listening for.
            </Row>
            <Row term="Team">
              Which team they play for. This helps rule out someone with a similar name.
            </Row>
            <Row term="Season">
              Which year to look in.
            </Row>
            <Row term="Games (optional)">
              One opponent per line, if you only care about certain games. Leave it empty to look
              across the whole season.
            </Row>
            <Row term="Script (optional)">
              If you already know the story you are telling, paste it in and Cut IQ will look for
              moments that fit it. Leave it blank and you get general coverage instead.
            </Row>
          </div>
        </Section>

        <Section title="How much to keep: the focus setting">
          <p>
            A season has far more moments than you want. The focus setting decides how picky Cut IQ is.
            Start with Balanced; move up or down once you see the results.
          </p>
          <div className="grid gap-3">
            <Row term="Everything">
              Keeps every moment it finds, including quiet ones where the name is just mentioned. Use
              it when you would rather sort through extras than miss something.
            </Row>
            <Row term="Balanced">
              Keeps the useful plays and drops routine mentions. A good default.
            </Row>
            <Row term="Highlights">
              Only the plays that stand out — scores, big gains, important downs.
            </Row>
            <Row term="Best Only">
              A short list of the strongest moments from each game. Use it when you want a quick reel,
              not a full archive.
            </Row>
            <Row term="Custom">
              Set the limits yourself. Everything below applies only in Custom.
            </Row>
          </div>
        </Section>

        <Section title="Custom settings">
          <div className="grid gap-3">
            <Row term="Maximum clips per game">
              A hard ceiling per game, so one busy game does not flood the results.
            </Row>
            <Row term="Minimum estimated yards">
              Skip plays shorter than this. Set it to 0 to keep everything regardless of distance.
            </Row>
            <Row term="Minimum excitement">
              A 0–25 score for how much the play stood out, based on how the broadcast talks about it.
              Higher means fewer, bigger moments. Around 8 is moderate; above 15 is very selective.
            </Row>
            <Row term="Include likely plays">
              Keep moments Cut IQ is fairly confident about but has not fully confirmed. Turn it on to
              catch more, off to keep results clean.
            </Row>
            <Row term="Always include touchdowns">
              Keep every score even if it would otherwise be filtered out. Usually worth leaving on.
            </Row>
            <Row term="Include key downs">
              Keep third and fourth down plays, which tend to matter more than the numbers suggest.
            </Row>
            <Row term="Include red zone plays">
              Keep plays close to the end zone, where short gains still matter.
            </Row>
          </div>
        </Section>

        <Section title="Reviewing and exporting">
          <p>
            Nothing is final until you say so. Results come back as a list you approve or reject, and
            you can adjust the start and end of any clip before exporting. Finished clips are written
            to your Videos folder and stay on your computer.
          </p>
        </Section>

        <Section title="Free and Pro">
          <p>
            Searching, reviewing, cutting by hand, and exporting one clip at a time are free, and stay
            free. A one-time Pro purchase adds the parts that save time when you are working at
            volume: exporting a whole project at once, packaging clips for delivery, and rendering
            above 720p.
          </p>
          <p>
            Your key is checked on your own computer. Cut IQ does not create an account or send your
            projects anywhere.
          </p>
        </Section>
      </main>
    </div>
  );
}
