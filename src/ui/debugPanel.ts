import type { PhysicsConfig } from "../core/physicsConfig";
import { metersToYards, radiansPerSecondToRpm } from "../core/unitConversion";
import type { Vec3 } from "../core/vector";
import type { ShotInput } from "../types/shot";
import type {
  ComparisonTarget,
  GraphicsQuality,
  GroundCondition,
  ProfileSelection,
  ReplayCameraMode,
  ShotAnalysisMetrics,
  SimulationFrame,
  SurfaceType,
  TrajectoryDisplayMode,
} from "../types/simulation";

interface RuntimeStats {
  frame: SimulationFrame;
  metrics: ShotAnalysisMetrics;
  /** Rendered frames per second, for checking the graphics presets. */
  fps: number;
}

interface DebugPanelOptions {
  container: HTMLElement;
  samples: ShotInput[];
  config: PhysicsConfig;
  onSampleSelected: (shot: ShotInput) => void;
  onBaselineSelected: (shot: ShotInput | null) => void;
  onJsonApplied: (shot: ShotInput) => void;
  onReplay: () => void;
  onReset: () => void;
  onPauseToggle: () => void;
  onCameraChange: (camera: ReplayCameraMode) => void;
  onGraphicsQualityChange: (quality: GraphicsQuality) => void;
  onTrajectoryModeChange: (mode: TrajectoryDisplayMode) => void;
  onComparisonTargetChange: (target: ComparisonTarget) => void;
  onProfileChange: (profile: ProfileSelection) => void;
  onEnvironmentChanged: (environment: {
    windSpeed: number;
    windDirection: number;
    altitude: number;
    groundCondition: GroundCondition;
    surfaceOverride: SurfaceType | "auto";
  }) => void;
  onConfigChanged: () => void;
}

export interface DebugPanel {
  setJson(shot: ShotInput): void;
  setRuntimeStats(stats: RuntimeStats): void;
  setPaused(paused: boolean): void;
  setError(message: string): void;
}

const formatDistance = (meters: number): string =>
  `${meters.toFixed(1)} m / ${metersToYards(meters).toFixed(1)} yd`;

const formatSignedDistance = (meters: number): string => {
  const direction = meters > 0.05 ? "R" : meters < -0.05 ? "L" : "C";
  return direction === "C" ? "Center" : `${Math.abs(meters).toFixed(1)} m ${direction}`;
};

const formatVelocity = (vector: Vec3): string => {
  const speed = Math.sqrt(vector.x * vector.x + vector.y * vector.y + vector.z * vector.z);
  return `${speed.toFixed(1)} m/s`;
};

const formatSpin = (vector: Vec3): string => {
  const spinRate = Math.sqrt(vector.x * vector.x + vector.y * vector.y + vector.z * vector.z);
  return `${radiansPerSecondToRpm(spinRate).toFixed(0)} rpm`;
};

const formatAngle = (degrees: number): string => `${degrees.toFixed(1)}°`;

const createNumberInput = (
  documentRef: Document,
  label: string,
  value: number,
  onCommit: (value: number) => void,
  step = "0.1",
): HTMLElement => {
  const wrapper = documentRef.createElement("label");
  wrapper.className = "control-grid";

  const labelElement = documentRef.createElement("span");
  labelElement.textContent = label;

  const input = documentRef.createElement("input");
  input.type = "number";
  input.step = step;
  input.value = value.toString();
  input.addEventListener("change", () => {
    onCommit(Number(input.value));
  });

  wrapper.append(labelElement, input);
  return wrapper;
};

const createSelectControl = <T extends string>(
  documentRef: Document,
  label: string,
  options: Array<{ label: string; value: T }>,
  value: T,
  onCommit: (value: T) => void,
): HTMLElement => {
  const wrapper = documentRef.createElement("label");
  wrapper.className = "control-grid";

  const labelElement = documentRef.createElement("span");
  labelElement.textContent = label;

  const select = documentRef.createElement("select");
  options.forEach((option) => {
    const element = documentRef.createElement("option");
    element.value = option.value;
    element.textContent = option.label;
    if (option.value === value) {
      element.selected = true;
    }
    select.append(element);
  });
  select.addEventListener("change", () => {
    onCommit(select.value as T);
  });

  wrapper.append(labelElement, select);
  return wrapper;
};

const createSummaryItem = (documentRef: Document, label: string) => {
  const card = documentRef.createElement("div");
  card.className = "summary-card";

  const labelElement = documentRef.createElement("span");
  labelElement.className = "summary-label";
  labelElement.textContent = label;

  const valueElement = documentRef.createElement("strong");
  valueElement.className = "summary-value";
  valueElement.textContent = "--";

  card.append(labelElement, valueElement);
  return { card, valueElement };
};

export const createDebugPanel = ({
  container,
  samples,
  config,
  onSampleSelected,
  onBaselineSelected,
  onJsonApplied,
  onReplay,
  onReset,
  onPauseToggle,
  onCameraChange,
  onGraphicsQualityChange,
  onTrajectoryModeChange,
  onComparisonTargetChange,
  onProfileChange,
  onEnvironmentChanged,
  onConfigChanged,
}: DebugPanelOptions): DebugPanel => {
  const documentRef = container.ownerDocument;
  const panel = documentRef.createElement("aside");
  panel.className = "debug-panel";

  const title = documentRef.createElement("h1");
  title.textContent = "Golf Flight Lab";

  const subtitle = documentRef.createElement("p");
  subtitle.className = "panel-subtitle";
  subtitle.textContent = "Analysis-first replay with profile, wind, surface, and comparison controls.";

  const profileHint = documentRef.createElement("p");
  profileHint.className = "panel-meta";
  profileHint.textContent = "Profile: --";

  const summarySection = documentRef.createElement("section");
  summarySection.className = "summary-grid";
  const summaryItems = {
    ballSpeed: createSummaryItem(documentRef, "Ball Speed"),
    launch: createSummaryItem(documentRef, "Launch"),
    spin: createSummaryItem(documentRef, "Spin"),
    carry: createSummaryItem(documentRef, "Carry"),
    total: createSummaryItem(documentRef, "Total"),
    apex: createSummaryItem(documentRef, "Apex"),
    offline: createSummaryItem(documentRef, "Offline"),
    landing: createSummaryItem(documentRef, "Landing"),
    descent: createSummaryItem(documentRef, "Descent"),
    hangTime: createSummaryItem(documentRef, "Hang Time"),
  };
  Object.values(summaryItems).forEach((item) => summarySection.append(item.card));

  const sampleSelect = documentRef.createElement("select");
  samples.forEach((shot, index) => {
    const option = documentRef.createElement("option");
    option.value = index.toString();
    option.textContent = shot.name ?? `Sample ${index + 1}`;
    sampleSelect.append(option);
  });
  sampleSelect.addEventListener("change", () => {
    onSampleSelected(samples[Number(sampleSelect.value)]);
  });

  const baselineSelect = documentRef.createElement("select");
  const noneOption = documentRef.createElement("option");
  noneOption.value = "-1";
  noneOption.textContent = "None";
  baselineSelect.append(noneOption);
  samples.forEach((shot, index) => {
    const option = documentRef.createElement("option");
    option.value = index.toString();
    option.textContent = shot.name ?? `Sample ${index + 1}`;
    baselineSelect.append(option);
  });
  baselineSelect.addEventListener("change", () => {
    const selectedIndex = Number(baselineSelect.value);
    onBaselineSelected(selectedIndex >= 0 ? samples[selectedIndex] : null);
  });

  const controlsSection = documentRef.createElement("section");
  controlsSection.className = "panel-section";
  const controlsTitle = documentRef.createElement("h2");
  controlsTitle.textContent = "Replay";

  const buttons = documentRef.createElement("div");
  buttons.className = "button-row";

  const replayButton = documentRef.createElement("button");
  replayButton.textContent = "Replay";
  replayButton.addEventListener("click", onReplay);

  const pauseButton = documentRef.createElement("button");
  pauseButton.textContent = "Pause";
  pauseButton.addEventListener("click", onPauseToggle);

  const resetButton = documentRef.createElement("button");
  resetButton.textContent = "Reset";
  resetButton.addEventListener("click", onReset);

  buttons.append(replayButton, pauseButton, resetButton);

  controlsSection.append(
    controlsTitle,
    createSelectControl(
      documentRef,
      "Shot",
      samples.map((shot, index) => ({
        label: shot.name ?? `Sample ${index + 1}`,
        value: index.toString(),
      })),
      "0",
      (value) => {
        sampleSelect.value = value;
        onSampleSelected(samples[Number(value)]);
      },
    ),
    createSelectControl<ReplayCameraMode>(
      documentRef,
      "Camera",
      [
        { label: "Broadcast", value: "broadcast" },
        { label: "Chase", value: "chase" },
        { label: "Top / Dispersion", value: "dispersion" },
      ],
      "broadcast",
      onCameraChange,
    ),
    createSelectControl<GraphicsQuality>(
      documentRef,
      "Graphics",
      [
        { label: "High (AO)", value: "high" },
        { label: "Standard", value: "standard" },
      ],
      "high",
      onGraphicsQualityChange,
    ),
    createSelectControl<TrajectoryDisplayMode>(
      documentRef,
      "Trajectory",
      [
        { label: "Full Flight", value: "full" },
        { label: "Carry Only", value: "carry_only" },
        { label: "Roll Only", value: "roll_only" },
        { label: "Comparison", value: "comparison" },
      ],
      "full",
      onTrajectoryModeChange,
    ),
    createSelectControl<ComparisonTarget>(
      documentRef,
      "Compare",
      [
        { label: "None", value: "none" },
        { label: "Previous Shot", value: "previous" },
        { label: "Baseline Shot", value: "baseline" },
      ],
      "previous",
      onComparisonTargetChange,
    ),
    createSelectControl(
      documentRef,
      "Baseline",
      [
        { label: "None", value: "-1" },
        ...samples.map((shot, index) => ({
          label: shot.name ?? `Sample ${index + 1}`,
          value: index.toString(),
        })),
      ],
      "-1",
      (value) => {
        baselineSelect.value = value;
        const selectedIndex = Number(value);
        onBaselineSelected(selectedIndex >= 0 ? samples[selectedIndex] : null);
      },
    ),
    buttons,
  );

  const environmentSection = documentRef.createElement("section");
  environmentSection.className = "panel-section";
  const environmentTitle = documentRef.createElement("h2");
  environmentTitle.textContent = "Environment";

  const environmentState = {
    windSpeed: 0,
    windDirection: 0,
    altitude: 0,
    groundCondition: "normal" as GroundCondition,
    surfaceOverride: "auto" as SurfaceType | "auto",
  };

  const emitEnvironment = () => {
    onEnvironmentChanged({ ...environmentState });
  };

  const environmentControls = documentRef.createElement("div");
  environmentControls.className = "config-controls";
  environmentControls.append(
    createSelectControl<ProfileSelection>(
      documentRef,
      "Profile",
      [
        { label: "Input / Default", value: "input_default" },
        { label: "Driver", value: "driver" },
        { label: "Long Iron", value: "long_iron" },
        { label: "Short Iron", value: "short_iron" },
        { label: "Wedge", value: "wedge" },
        { label: "Low Speed", value: "putt_like" },
      ],
      "input_default",
      onProfileChange,
    ),
    createNumberInput(documentRef, "Wind Speed", 0, (value) => {
      environmentState.windSpeed = value;
      emitEnvironment();
    }),
    createNumberInput(documentRef, "Wind Dir", 0, (value) => {
      environmentState.windDirection = value;
      emitEnvironment();
    }),
    createNumberInput(documentRef, "Altitude", 0, (value) => {
      environmentState.altitude = value;
      emitEnvironment();
    }),
    createSelectControl<GroundCondition>(
      documentRef,
      "Ground",
      [
        { label: "Normal", value: "normal" },
        { label: "Dry", value: "dry" },
        { label: "Wet", value: "wet" },
      ],
      "normal",
      (value) => {
        environmentState.groundCondition = value;
        emitEnvironment();
      },
    ),
    createSelectControl<SurfaceType | "auto">(
      documentRef,
      "Surface",
      [
        { label: "Auto", value: "auto" },
        { label: "Fairway", value: "fairway" },
        { label: "Rough", value: "rough" },
        { label: "Green", value: "green" },
        { label: "Bunker", value: "bunker" },
        { label: "Fringe", value: "fringe" },
        { label: "Tee", value: "tee" },
      ],
      "auto",
      (value) => {
        environmentState.surfaceOverride = value;
        emitEnvironment();
      },
    ),
  );
  environmentSection.append(environmentTitle, environmentControls);

  const runtimeSection = documentRef.createElement("section");
  runtimeSection.className = "panel-section";
  const runtimeTitle = documentRef.createElement("h2");
  runtimeTitle.textContent = "Live";
  const runtimeGrid = documentRef.createElement("dl");
  runtimeGrid.className = "stats-grid";
  const statValues = new Map<string, HTMLElement>();
  ["Height", "Velocity", "Spin", "Phase", "Surface", "FPS"].forEach((label) => {
    const dt = documentRef.createElement("dt");
    dt.textContent = label;
    const dd = documentRef.createElement("dd");
    dd.textContent = "--";
    statValues.set(label, dd);
    runtimeGrid.append(dt, dd);
  });
  runtimeSection.append(runtimeTitle, runtimeGrid);

  const jsonSection = documentRef.createElement("section");
  jsonSection.className = "panel-section";
  const jsonTitle = documentRef.createElement("h2");
  jsonTitle.textContent = "Shot JSON";
  const textarea = documentRef.createElement("textarea");
  textarea.className = "shot-json";
  textarea.spellcheck = false;
  const errorText = documentRef.createElement("p");
  errorText.className = "error-text";
  const applyButton = documentRef.createElement("button");
  applyButton.textContent = "Apply JSON";
  applyButton.addEventListener("click", () => {
    try {
      const parsed = JSON.parse(textarea.value) as ShotInput;
      errorText.textContent = "";
      onJsonApplied(parsed);
    } catch {
      errorText.textContent = "Shot JSON must be valid JSON before it can be applied.";
    }
  });
  jsonSection.append(jsonTitle, textarea, errorText, applyButton);

  const configSection = documentRef.createElement("section");
  configSection.className = "panel-section";
  const configTitle = documentRef.createElement("h2");
  configTitle.textContent = "Physics";
  const configControls = documentRef.createElement("div");
  configControls.className = "config-controls";
  configControls.append(
    createNumberInput(documentRef, "Drag Coeff", config.aerodynamics.dragCoefficient, (value) => {
      config.aerodynamics.dragCoefficient = value;
      onConfigChanged();
    }, "0.01"),
    createNumberInput(documentRef, "Backspin Lift", config.aerodynamics.backSpinLiftCoefficient, (value) => {
      config.aerodynamics.backSpinLiftCoefficient = value;
      onConfigChanged();
    }, "0.01"),
    createNumberInput(documentRef, "Sidespin Curve", config.aerodynamics.sideSpinCurveCoefficient, (value) => {
      config.aerodynamics.sideSpinCurveCoefficient = value;
      onConfigChanged();
    }, "0.01"),
    createNumberInput(documentRef, "Backspin Decay", config.aerodynamics.backSpinDecayRatePerSecond, (value) => {
      config.aerodynamics.backSpinDecayRatePerSecond = value;
      onConfigChanged();
    }, "0.01"),
    createNumberInput(documentRef, "Sidespin Decay", config.aerodynamics.sideSpinDecayRatePerSecond, (value) => {
      config.aerodynamics.sideSpinDecayRatePerSecond = value;
      onConfigChanged();
    }, "0.01"),
  );
  configSection.append(configTitle, configControls);

  panel.append(
    title,
    subtitle,
    profileHint,
    summarySection,
    controlsSection,
    environmentSection,
    runtimeSection,
    jsonSection,
    configSection,
  );
  container.append(panel);

  return {
    setJson(shot) {
      textarea.value = JSON.stringify(shot, null, 2);
    },
    setRuntimeStats({ frame, metrics, fps }) {
      summaryItems.ballSpeed.valueElement.textContent = `${metrics.ballSpeedMps.toFixed(1)} m/s`;
      summaryItems.launch.valueElement.textContent = `${formatAngle(metrics.launchAngleDeg)} / ${formatAngle(metrics.launchDirectionDeg)}`;
      summaryItems.spin.valueElement.textContent = `${metrics.spinRpm.toFixed(0)} rpm`;
      summaryItems.carry.valueElement.textContent = formatDistance(metrics.carryDistanceM);
      summaryItems.total.valueElement.textContent = formatDistance(metrics.totalDistanceM);
      summaryItems.apex.valueElement.textContent = formatDistance(metrics.apexHeightM);
      summaryItems.offline.valueElement.textContent = formatSignedDistance(metrics.lateralDeviationM);
      summaryItems.landing.valueElement.textContent = formatAngle(metrics.landingAngleDeg);
      summaryItems.descent.valueElement.textContent = formatAngle(metrics.descentAngleDeg);
      summaryItems.hangTime.valueElement.textContent = `${metrics.hangTimeS.toFixed(2)} s`;
      profileHint.textContent = `Profile: ${metrics.profileId.replace("_", " ")} | Recommended: ${metrics.recommendedProfileId.replace("_", " ")}`;
      statValues.get("Height")!.textContent = formatDistance(Math.max(0, frame.position.y - config.ball.radiusM));
      statValues.get("Velocity")!.textContent = formatVelocity(frame.velocity);
      statValues.get("Spin")!.textContent = formatSpin(frame.spin);
      statValues.get("Phase")!.textContent = frame.phase;
      statValues.get("Surface")!.textContent = frame.surface;
      statValues.get("FPS")!.textContent = fps.toFixed(0);
    },
    setPaused(paused) {
      pauseButton.textContent = paused ? "Resume" : "Pause";
    },
    setError(message) {
      errorText.textContent = message;
    },
  };
};
