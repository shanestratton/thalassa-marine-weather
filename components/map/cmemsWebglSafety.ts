type WebGlContext = WebGLRenderingContext | WebGL2RenderingContext;

const MAX_ERROR_DRAIN = 16;

function errorLabel(gl: WebGlContext, error: number): string {
    if (error === gl.OUT_OF_MEMORY) return 'OUT_OF_MEMORY';
    if (error === gl.INVALID_ENUM) return 'INVALID_ENUM';
    if (error === gl.INVALID_VALUE) return 'INVALID_VALUE';
    if (error === gl.INVALID_OPERATION) return 'INVALID_OPERATION';
    if (error === gl.INVALID_FRAMEBUFFER_OPERATION) return 'INVALID_FRAMEBUFFER_OPERATION';
    if (error === gl.CONTEXT_LOST_WEBGL) return 'CONTEXT_LOST_WEBGL';
    return `0x${error.toString(16)}`;
}

export function requireWebGlResource<T>(resource: T | null, owner: string, label: string): T {
    if (resource === null) throw new Error(`[${owner}] failed to allocate ${label}`);
    return resource;
}

export function requireWebGlAttribute(location: number, owner: string, label: string): number {
    if (location < 0) throw new Error(`[${owner}] missing required attribute ${label}`);
    return location;
}

export function requireWebGlUniform<T>(location: T | null, owner: string, label: string): T {
    if (location === null) throw new Error(`[${owner}] missing required uniform ${label}`);
    return location;
}

/** Clear errors left by Mapbox before attributing the next error to our operation. */
export function beginWebGlOperation(gl: WebGlContext, owner: string, label: string): void {
    if (gl.isContextLost?.()) throw new Error(`[${owner}] ${label} rejected: WebGL context is lost`);
    for (let index = 0; index < MAX_ERROR_DRAIN; index++) {
        if (gl.getError() === gl.NO_ERROR) return;
    }
    throw new Error(`[${owner}] ${label} rejected: WebGL error queue did not clear`);
}

export function proveWebGlOperation(gl: WebGlContext, owner: string, label: string): void {
    const error = gl.getError();
    if (error === gl.NO_ERROR) return;
    // Drain the remainder so a failed CMEMS operation cannot poison Mapbox's
    // interpretation of a later, unrelated WebGL call.
    for (let index = 1; index < MAX_ERROR_DRAIN && gl.getError() !== gl.NO_ERROR; index++) {
        // Intentionally empty.
    }
    throw new Error(`[${owner}] ${label} failed: WebGL ${errorLabel(gl, error)}`);
}

export function createWebGlProgram(
    gl: WebGlContext,
    owner: string,
    vertexSource: string,
    fragmentSource: string,
    label: string,
): WebGLProgram {
    let vertexShader: WebGLShader | null = null;
    let fragmentShader: WebGLShader | null = null;
    let program: WebGLProgram | null = null;
    try {
        vertexShader = compileShader(gl, owner, gl.VERTEX_SHADER, vertexSource, `${label} vertex shader`);
        fragmentShader = compileShader(gl, owner, gl.FRAGMENT_SHADER, fragmentSource, `${label} fragment shader`);
        program = requireWebGlResource(gl.createProgram(), owner, `${label} program`);
        gl.attachShader(program, vertexShader);
        gl.attachShader(program, fragmentShader);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            throw new Error(`[${owner}] ${label} link failed: ${gl.getProgramInfoLog(program) ?? 'unknown error'}`);
        }
        proveWebGlOperation(gl, owner, `${label} program link`);
        return program;
    } catch (error) {
        if (program) gl.deleteProgram(program);
        throw error;
    } finally {
        if (vertexShader) gl.deleteShader(vertexShader);
        if (fragmentShader) gl.deleteShader(fragmentShader);
    }
}

function compileShader(gl: WebGlContext, owner: string, type: number, source: string, label: string): WebGLShader {
    const shader = requireWebGlResource(gl.createShader(type), owner, label);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const info = gl.getShaderInfoLog(shader) ?? 'unknown error';
        gl.deleteShader(shader);
        throw new Error(`[${owner}] ${label} compile failed: ${info}`);
    }
    return shader;
}
