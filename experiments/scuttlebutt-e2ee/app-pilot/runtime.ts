/** One isolated composition per mounted window. No second Auth verification
 * loop, production SDK, automatic setup or legacy fallback. Injected native/SDK
 * dependencies are test fixtures, not evidence of encryption or native Auth.
 */
import { createNativePrivateMessageStartup } from '../../../services/chat/e2ee/privateMessageStartup';
import { createPrivateMessagePilotRuntime } from '../../../services/chat/e2ee/privateMessagePilot';
import { ResearchAuthController, researchNativePlugin, type ResearchAuthDependencies } from '../bridge-web/auth';
import {
    createResearchPrivateAdmissionSource,
    type ResearchPrivateAdmissionBindings,
} from '../bridge-web/privateAdmissionSource';
import {
    createResearchPrivateMessageNativePlugin,
    type ResearchPrivateMessagePluginBindings,
} from '../bridge-web/privateMessagePort';

export function createPrivateMessageResearchRuntime(options?: {
    auth: ResearchAuthDependencies;
    native: ResearchPrivateAdmissionBindings & ResearchPrivateMessagePluginBindings;
}) {
    const native = options?.native ?? researchNativePlugin;
    const source = createResearchPrivateAdmissionSource(native);
    // Construct before SDK initialization; this always installs one-way denial.
    const admission = createNativePrivateMessageStartup({ native: source });
    const auth = options ? new ResearchAuthController(options.auth) : new ResearchAuthController();
    const port = createResearchPrivateMessageNativePlugin(native);
    return Object.freeze({ auth, admission, source, port, runtime: createPrivateMessagePilotRuntime(port) });
}
export type PrivateMessageResearchRuntime = ReturnType<typeof createPrivateMessageResearchRuntime>;
