import { simulateBallFlight } from "./core/ballistics";
import { defaultPhysicsConfig } from "./core/physicsConfig";
import { mapShotToInitialConditions } from "./core/shotMapper";
import { normalizeShotInput } from "./core/unitConversion";
import { sampleShots } from "./data/sampleShots";
import { createBallRenderer } from "./render/ballRenderer";
import { createSceneController } from "./render/scene";
import { createTrajectoryRenderer } from "./render/trajectoryRenderer";
import { createDebugPanel } from "./ui/debugPanel";
import type { ShotInput } from "./types/shot";
import type {
  ComparisonTarget,
  GroundCondition,
  ProfileSelection,
  ReplayCameraMode,
  ShotSession,
  SimulationResult,
  SurfaceType,
  TrajectoryDisplayMode,
} from "./types/simulation";

interface EnvironmentOverrides {
  windSpeed: number;
  windDirection: number;
  altitude: number;
  groundCondition: GroundCondition;
  surfaceOverride: SurfaceType | "auto";
}

export class GolfFlightApp {
  private readonly sceneController;
  private readonly ballRenderer;
  private readonly trajectoryRenderer;
  private readonly debugPanel;
  private readonly physicsConfig = defaultPhysicsConfig();
  private readonly samples = sampleShots;

  private currentShot: ShotInput = this.samples[0];
  private baselineShot: ShotInput | null = this.samples[1] ?? null;
  private simulation: SimulationResult | null = null;
  private previousSimulation: SimulationResult | null = null;
  private baselineSimulation: SimulationResult | null = null;
  private playbackTimeS = 0;
  private paused = false;
  private cameraMode: ReplayCameraMode = "broadcast";
  private trajectoryMode: TrajectoryDisplayMode = "full";
  private comparisonTarget: ComparisonTarget = "previous";
  private profileSelection: ProfileSelection = "input_default";
  private environmentOverrides: EnvironmentOverrides = {
    windSpeed: 0,
    windDirection: 0,
    altitude: 0,
    groundCondition: "normal",
    surfaceOverride: "auto",
  };
  private shotSession: ShotSession = {
    id: "local-session",
    title: "Local Analysis Session",
    entries: [],
  };

  public constructor(canvas: HTMLCanvasElement, uiRoot: HTMLElement) {
    this.sceneController = createSceneController(canvas);
    const groundHeightAt = (x: number, z: number): number =>
      this.sceneController.getGroundHeightAt(x, z);
    this.ballRenderer = createBallRenderer(
      this.sceneController.scene,
      this.physicsConfig.ball.radiusM,
      groundHeightAt,
    );
    this.trajectoryRenderer = createTrajectoryRenderer(
      this.sceneController.scene,
      groundHeightAt,
    );
    this.sceneController.attachFollowTarget(this.ballRenderer.mesh);
    this.sceneController.setActiveCamera(this.cameraMode);

    this.debugPanel = createDebugPanel({
      container: uiRoot,
      samples: this.samples,
      config: this.physicsConfig,
      onSampleSelected: (shot) => {
        this.currentShot = shot;
        this.debugPanel.setJson(shot);
        this.rebuildSimulation(true);
      },
      onBaselineSelected: (shot) => {
        this.baselineShot = shot;
        this.rebuildBaselineSimulation();
        this.updateTrajectoryDisplay();
      },
      onJsonApplied: (shot) => {
        this.currentShot = shot;
        this.rebuildSimulation(true);
      },
      onReplay: () => {
        this.playbackTimeS = 0;
        this.paused = false;
        this.debugPanel.setPaused(this.paused);
      },
      onReset: () => {
        this.playbackTimeS = 0;
        this.paused = true;
        this.debugPanel.setPaused(this.paused);
        this.renderCurrentFrame();
      },
      onPauseToggle: () => {
        this.paused = !this.paused;
        this.debugPanel.setPaused(this.paused);
      },
      onCameraChange: (camera) => {
        this.cameraMode = camera;
        this.sceneController.setActiveCamera(camera);
      },
      onGraphicsQualityChange: (quality) => {
        this.sceneController.setGraphicsQuality(quality);
      },
      onTrajectoryModeChange: (mode) => {
        this.trajectoryMode = mode;
        this.updateTrajectoryDisplay();
      },
      onComparisonTargetChange: (target) => {
        this.comparisonTarget = target;
        this.updateTrajectoryDisplay();
      },
      onProfileChange: (profile) => {
        this.profileSelection = profile;
        this.rebuildSimulation(false);
      },
      onEnvironmentChanged: (environment) => {
        this.environmentOverrides = environment;
        this.rebuildSimulation(false);
      },
      onConfigChanged: () => {
        this.rebuildSimulation(false);
      },
    });

    this.debugPanel.setJson(this.currentShot);
    this.rebuildSimulation(true);

    this.sceneController.engine.runRenderLoop(() => {
      const deltaSeconds = this.sceneController.engine.getDeltaTime() / 1000;
      this.tick(deltaSeconds);
      this.sceneController.scene.render();
    });

    window.addEventListener("resize", () => {
      this.sceneController.resize();
    });
  }

  private buildEffectiveShot(shot: ShotInput): ShotInput {
    return {
      ...shot,
      clubType:
        this.profileSelection === "input_default"
          ? shot.clubType
          : this.profileSelection,
      environment: {
        ...shot.environment,
        windSpeed: this.environmentOverrides.windSpeed,
        windDirection: this.environmentOverrides.windDirection,
        altitude: this.environmentOverrides.altitude,
        groundCondition: this.environmentOverrides.groundCondition,
      },
      surfaceOverride:
        this.environmentOverrides.surfaceOverride === "auto"
          ? shot.surfaceOverride
          : this.environmentOverrides.surfaceOverride,
    };
  }

  private buildSimulation(shot: ShotInput): SimulationResult {
    const effectiveShot = this.buildEffectiveShot(shot);
    const normalized = normalizeShotInput(effectiveShot);
    const initialConditions = mapShotToInitialConditions(normalized, this.physicsConfig);

    return simulateBallFlight(initialConditions, {
      config: this.physicsConfig,
      shot: normalized,
      surfaceResolver: (x, z) => this.sceneController.getSurfaceTypeAt(x, z),
      groundHeightResolver: (x, z) => this.sceneController.getGroundHeightAt(x, z),
    });
  }

  private updateTrajectoryDisplay(): void {
    const comparison =
      this.comparisonTarget === "previous"
        ? this.previousSimulation
        : this.comparisonTarget === "baseline"
          ? this.baselineSimulation
          : null;

    this.trajectoryRenderer.setTrajectories({
      current: this.simulation
        ? {
            points: this.simulation.frames.map((frame) => frame.position),
            landingPoint: this.simulation.metrics.landingPoint,
            segments: this.simulation.segments,
          }
        : null,
      comparison:
        this.trajectoryMode === "comparison" && comparison
          ? {
              points: comparison.frames.map((frame) => frame.position),
              landingPoint: comparison.metrics.landingPoint,
              segments: comparison.segments,
            }
          : null,
      mode: this.trajectoryMode,
    });
  }

  private rebuildBaselineSimulation(): void {
    if (!this.baselineShot) {
      this.baselineSimulation = null;
      return;
    }

    try {
      this.baselineSimulation = this.buildSimulation(this.baselineShot);
    } catch {
      this.baselineSimulation = null;
    }
  }

  private appendSessionEntry(result: SimulationResult): void {
    this.shotSession.entries = [
      ...this.shotSession.entries,
      {
        shotName: this.currentShot.name ?? "Custom Shot",
        recordedAtIso: new Date().toISOString(),
        metrics: result.metrics,
      },
    ].slice(-16);
  }

  private rebuildSimulation(restartPlayback: boolean): void {
    try {
      const nextSimulation = this.buildSimulation(this.currentShot);

      if (this.simulation) {
        this.previousSimulation = this.simulation;
      }
      this.simulation = nextSimulation;
      this.rebuildBaselineSimulation();
      this.updateTrajectoryDisplay();

      this.debugPanel.setError("");
      if (restartPlayback) {
        this.playbackTimeS = 0;
        this.paused = false;
        this.appendSessionEntry(nextSimulation);
      }
      this.debugPanel.setPaused(this.paused);
      this.renderCurrentFrame();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to build simulation.";
      this.debugPanel.setError(message);
    }
  }

  private getCurrentFrame() {
    if (!this.simulation) {
      return null;
    }

    const index = Math.min(
      Math.floor(this.playbackTimeS / this.physicsConfig.simulation.fixedTimestep),
      this.simulation.frames.length - 1,
    );

    return this.simulation.frames[index];
  }

  private renderCurrentFrame(): void {
    if (!this.simulation) {
      return;
    }

    const frame = this.getCurrentFrame();
    if (!frame) {
      return;
    }

    this.ballRenderer.update(frame);
    this.trajectoryRenderer.highlightFrame(frame.position);
    this.sceneController.updateReplayCamera(frame, this.simulation.metrics);
    this.debugPanel.setRuntimeStats({
      frame,
      metrics: this.simulation.metrics,
      fps: this.sceneController.engine.getFps(),
    });
  }

  private tick(deltaSeconds: number): void {
    if (this.simulation && !this.paused) {
      const maxTime = this.simulation.frames[this.simulation.frames.length - 1].time;
      this.playbackTimeS = Math.min(this.playbackTimeS + deltaSeconds, maxTime);

      if (this.playbackTimeS >= maxTime) {
        this.paused = true;
        this.debugPanel.setPaused(true);
      }
    }

    this.renderCurrentFrame();
  }
}
