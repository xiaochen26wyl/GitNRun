import { iosServiceAlive } from "@shared/ios-simulator";
import { execForOutput } from "@main/run/port-sweep";

const XCRUN = "/usr/bin/xcrun";
const PS = "/bin/ps";

/** 綁定特定 UDID 的 iOS 服務是否還活著（沒有 port 可探測）；任何指令失敗都當作沒在跑。 */
export const isIosServiceAlive = async (udid: string): Promise<boolean> => {
  const [simctl, table] = await Promise.all([
    execForOutput(XCRUN, ["simctl", "list", "devices", "booted", "-j"]),
    execForOutput(PS, ["-axo", "command="])
  ]);
  if (simctl.code !== 0 || table.code !== 0) return false;
  return iosServiceAlive({ simctlJson: simctl.stdout, psOutput: table.stdout, udid });
};
