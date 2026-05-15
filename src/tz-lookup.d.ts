declare module 'tz-lookup' {
    /** Returns the IANA timezone name at (lat, lon). Never throws under
     *  normal inputs; falls back to the nearest land's TZ for ocean coords. */
    const tzlookup: (lat: number, lon: number) => string;
    export default tzlookup;
}
