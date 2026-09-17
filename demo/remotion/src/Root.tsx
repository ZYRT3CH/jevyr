import { Composition } from 'remotion';
import { JevyrExplainer, JevyrLaunchShort, JevyrWhatIfShort, type JevyrExplainerProps } from './JevyrExplainer';

const defaultProps: JevyrExplainerProps = {
  title: 'JEVYR',
  subtitle: 'An AI judge for claims, plans, code, and decisions.',
};

export const Root: React.FC = () => (
  <>
    <Composition
      id="JevyrExplainer"
      component={JevyrExplainer}
      durationInFrames={30 * 300}
      fps={30}
      width={1920}
      height={1080}
      defaultProps={defaultProps}
    />
    <Composition
      id="JevyrLaunchShort"
      component={JevyrLaunchShort}
      durationInFrames={30 * 60}
      fps={30}
      width={1920}
      height={1080}
      defaultProps={defaultProps}
    />
    <Composition
      id="JevyrWhatIfShort"
      component={JevyrWhatIfShort}
      durationInFrames={30 * 60}
      fps={30}
      width={1920}
      height={1080}
      defaultProps={defaultProps}
    />
  </>
);
