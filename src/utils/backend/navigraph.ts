import { createHash, randomBytes } from 'node:crypto';

function base64URLEncode(str: Buffer) {
    return str
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
}

export function getNavigraphCodeVerifier() {
    return base64URLEncode(randomBytes(32));
}

function sha256(buffer: string) {
    return createHash('sha256').update(buffer).digest();
}

export function getNavigraphCodeChallenge(codeVerifier: string) {
    return base64URLEncode(sha256(codeVerifier));
}

export function getNavigraphRedirectUri() {
    return `${ useRuntimeConfig().DOMAIN }/auth/navigraph`;
}