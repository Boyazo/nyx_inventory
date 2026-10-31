/* 2027 NYX build season schedule, loaded into season_sections / season_tasks by "Load 2027 template".
 * Task due dates default to the end of their week. */

const CAD = "CAD", ME = "Mechanical/electrical", SW = "Software";

export const SEASON_TEMPLATE = [
  {
    kind: "info", label: "At a glance", title: "Mechanically complete Feb 19, driving Feb 20",
    body: "The robot should be mechanically complete by **Feb 19** and driving on **Feb 20**, which leaves four weeks for tuning, autos, and drive practice before **Mar 20**.\n\nCAD freeze on **Feb 6** is the hinge: a slip there pushes fabrication and every gate after it.",
  },
  {
    kind: "info", label: "Weekly rhythm", title: "Saturday to Friday",
    body: "Weeks run Saturday to Friday, so every week opens with an all-team review and closes with a demo.\n\n- **Saturday all-team start (30 min):** check off last week's boxes below, adjust this week's goals, and call out blockers.\n- **Midweek leads sync (15 min):** CAD, mechanical/electrical, and software leads confirm handoffs: drawings to fabrication, mechanisms to wiring, robot time to software.\n- **Protected robot time:** once the robot drives, reserve part of every meeting for software testing and drive practice.\n- **End-of-week demo:** each subteam shows one thing that works.",
  },
  {
    label: "Week 1", title: "Kickoff and strategy", start: "2027-01-09", end: "2027-01-15",
    gate: ["Robot archetype locked", "2027-01-12"],
    body: "Whole team: read the game manual, take a rules quiz, rank scoring actions, and lock the robot archetype by Tuesday, Jan 12.",
    tasks: {
      [CAD]: ["Import field elements and game piece models", "Sketch the robot layout: frame perimeter, height limits, mechanism zones"],
      [ME]: ["Build wooden mockups of key field elements", "Start quick cardboard and wood prototypes of top-ranked mechanisms", "Inventory motors, controllers, and batteries; test anything suspect"],
      [SW]: ["Install the 2027 WPILib release and update vendor libraries", "Create the season repo and get last year's drive code running on the test chassis", "Load the 2027 field layout and vision target positions"],
    },
  },
  {
    label: "Week 2", title: "Prototyping", start: "2027-01-16", end: "2027-01-22",
    body: "Goal: test every candidate mechanism with real game pieces and record the numbers.",
    tasks: {
      [CAD]: ["Concept CAD of two options per mechanism", "Master sketch with mechanism packaging and center-of-gravity targets"],
      [ME]: ["Iterate prototypes; log speeds, compression, and cycle times", "Assemble the competition drivebase", "Wire a prototype test board with motor controllers"],
      [SW]: ["Write prototype test code with speeds tunable from the dashboard", "Set up simulation and logging", "Get odometry working on the test chassis"],
    },
  },
  {
    label: "Week 3", title: "Choose and design", start: "2027-01-23", end: "2027-01-29",
    gate: ["Prototype review picks one design per mechanism", "2027-01-23"],
    body: "Gate: prototype review on Sat, Jan 23 picks one design per mechanism.",
    tasks: {
      [CAD]: ["Detailed CAD of the drivebase and primary scoring mechanism", "Order long-lead parts: motors, gearboxes, belts, stock"],
      [ME]: ["Refine prototypes of the chosen designs to confirm geometry", "Plan the electrical layout with CAD: PDH, roboRIO, radio, main breaker, CAN map"],
      [SW]: ["Vision and pose estimation on the test chassis", "Path following with PathPlanner or Choreo", "Subsystem skeletons that match the chosen mechanisms"],
    },
  },
  {
    label: "Week 4", title: "Finish CAD", start: "2027-01-30", end: "2027-02-05",
    body: "Goal: every mechanism fully designed and ready for the Feb 6 freeze.",
    tasks: {
      [CAD]: ["Complete CAD of all mechanisms with a weight estimate under the limit", "Make drawings and CAM files for manufacturing"],
      [ME]: ["Drivebase driving on competition electronics", "Start manufacturing parts as each mechanism is released"],
      [SW]: ["Put gear ratios, limits, and CAN IDs from CAD into constants", "Simulate mechanisms and test command logic in sim", "Draft the first autonomous routines in simulation"],
    },
  },
  {
    label: "Week 5", title: "Build", start: "2027-02-06", end: "2027-02-12",
    gate: ["Design review and CAD freeze", "2027-02-06"],
    body: "Gate: design review and CAD freeze on Sat, Feb 6.",
    tasks: {
      [CAD]: ["Release remaining drawings and track every part on a fab list", "Design bumpers and the battery mount"],
      [ME]: ["Fabricate and assemble mechanisms", "Wire each mechanism as it mounts; label every wire and CAN device"],
      [SW]: ["Bench-test each subsystem's motors and sensors as wiring finishes", "Write the driver and operator control maps"],
    },
  },
  {
    label: "Week 6", title: "Integrate", start: "2027-02-13", end: "2027-02-19",
    body: "Goal: robot mechanically complete by Fri, Feb 19.",
    tasks: {
      [CAD]: ["Update CAD to match as-built changes", "Start v2 fixes for problems found in assembly"],
      [ME]: ["Mount all mechanisms on the competition drivebase", "Cable management, strain relief, and a pull test on every connection"],
      [SW]: ["Bring-up: check motor directions, encoder signs, and soft limits", "Characterize the drivetrain and mechanisms with SysId and tune PID"],
    },
  },
  {
    label: "Week 7", title: "First drive and tuning", start: "2027-02-20", end: "2027-02-26",
    gate: ["Robot complete and driving", "2027-02-20"],
    body: "Gate: robot complete and driving on Sat, Feb 20.",
    tasks: {
      [CAD]: ["Design fixes for anything that fails in testing", "List and model the spare parts to bring"],
      [ME]: ["Fix and reinforce whatever breaks", "Weigh the robot and plan cuts if it's over"],
      [SW]: ["Tune scoring sequences and automation", "Run the first auto on the real robot", "Start drive practice at every meeting"],
    },
  },
  {
    label: "Week 8", title: "Iterate", start: "2027-02-27", end: "2027-03-05",
    body: "Goal: robot scores reliably through full mock matches.",
    tasks: {
      [CAD]: ["Finalize v2 mechanism upgrades", "Release spare-part drawings"],
      [ME]: ["Install v2 upgrades and finish bumpers", "Run full mock matches and log every failure"],
      [SW]: ["Add more autos and an auto chooser on the dashboard", "Review logs after each practice and fix faults"],
    },
  },
  {
    label: "Week 9", title: "Reliability", start: "2027-03-06", end: "2027-03-12",
    gate: ["Autos running and robot weighed", "2027-03-06"],
    body: "Gate: autos running and robot weighed on Sat, Mar 6.",
    tasks: {
      [CAD]: ["Make spare parts", "Prepare CAD renders and design-story visuals for the pit and judges"],
      [ME]: ["Build spare mechanism parts and a spare electrical kit", "Label, test, and log every battery"],
      [SW]: ["Feature freeze: bug fixes and tuning only", "Finalize the driver dashboard and practice recovering from faults"],
    },
  },
  {
    label: "Week 10", title: "Competition ready", start: "2027-03-13", end: "2027-03-20",
    gate: ["Competition ready", "2027-03-20"],
    body: "Goal: pass the checklist below by Sat, Mar 20.",
    tasks: {
      [CAD]: ["Final as-built CAD and robot images for judges and scouting"],
      [ME]: ["Self-inspect against the 2027 rules", "Pack pit tools, spares, and batteries"],
      [SW]: ["Tag the competition release in Git and set up a backup laptop with the code", "Final drive practice and auto checks on the field mockups"],
    },
  },
  {
    kind: "checklist", label: "Checklist", title: "Competition-readiness checklist", start: "2027-03-13", end: "2027-03-20",
    body: "Every box should be checked by Mar 20; take exact limits from the 2027 game manual and inspection checklist.",
    tasks: {
      "": [
        "Robot weight under the limit (bumpers and battery excluded, per the rules)",
        "Frame perimeter and height within limits in every configuration",
        "Bumpers built to spec in both alliance colors",
        "Main breaker reachable, wires labeled and strain-relieved, CAN connections secure",
        "Radio mounted and configured as the rules require",
        "Batteries labeled, tested, and charged on a rotation",
        "Code tagged in Git, driver station laptop updated, backup laptop ready",
        "Autos tested on the real robot and selectable on the dashboard",
        "Drive team chosen and practiced: driver, operator, coach, human player",
        "Pit kit packed: tools, spare parts, spare motors and controllers",
        "Scouting system tested and scouts trained",
      ],
    },
  },
];
