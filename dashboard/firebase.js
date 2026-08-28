(() => {

    "use strict";


    // ============================================================
    // CONFIG
    // ============================================================

    const config = window.WIND_DASHBOARD_CONFIG;


    if (!config) {

        console.error(
            "[Wind Dashboard] WIND_DASHBOARD_CONFIG was not found."
        );

        return;
    }


    if (!config.firebaseLiveUrl) {

        console.error(
            "[Wind Dashboard] firebaseLiveUrl is missing."
        );

        return;
    }


    console.log(
        "[Wind Dashboard] Starting Firebase live connection..."
    );


    // ============================================================
    // STATE
    // ============================================================

    let liveData = {

        windMs: 0,

        windKmh: 0,

        windAdcV: 0,

        sensorV: 0,

        rawAdc: 0,

        timestamp: 0

    };


    let lastReceivedAt = 0;

    let stream = null;

    let connected = false;


    // Make values available to any other dashboard scripts.
    window.WIND_LIVE_DATA = liveData;


    // ============================================================
    // HELPERS
    // ============================================================

    function numberOrZero(value) {

        const number = Number(value);

        return Number.isFinite(number)
            ? number
            : 0;
    }


    function setText(id, value) {

        const element =
            document.getElementById(id);

        if (element) {

            element.textContent = value;

        }

    }


    function setStatus(text, isLive) {

        const element =
            document.getElementById("liveStatus");

        if (!element)
            return;


        element.textContent = text;


        element.classList.remove(
            "live",
            "offline"
        );


        element.classList.add(
            isLive
                ? "live"
                : "offline"
        );

    }


    // ============================================================
    // UPDATE DASHBOARD
    // ============================================================

    function updateDashboard(data) {

        if (!data)
            return;


        // --------------------------------------------------------
        // Wind speed m/s
        // --------------------------------------------------------

        setText(
            "windMs",
            numberOrZero(
                data.windMs
            ).toFixed(2)
        );


        // --------------------------------------------------------
        // Wind speed km/h
        // --------------------------------------------------------

        setText(
            "windKmh",
            numberOrZero(
                data.windKmh
            ).toFixed(2)
        );


        // --------------------------------------------------------
        // ADC voltage
        // --------------------------------------------------------

        setText(
            "windAdcV",
            numberOrZero(
                data.windAdcV
            ).toFixed(3)
        );


        // --------------------------------------------------------
        // Sensor voltage
        // --------------------------------------------------------

        setText(
            "sensorV",
            numberOrZero(
                data.sensorV
            ).toFixed(3)
        );


        // --------------------------------------------------------
        // Raw ADC
        // --------------------------------------------------------

        setText(
            "rawAdc",
            Math.round(
                numberOrZero(
                    data.rawAdc
                )
            )
        );


        // --------------------------------------------------------
        // Timestamp
        // --------------------------------------------------------

        if (data.timestamp) {

            const date =
                new Date(
                    Number(
                        data.timestamp
                    )
                );


            setText(
                "lastUpdate",
                date.toLocaleTimeString()
            );

        }


        // --------------------------------------------------------
        // Optional browser title
        // --------------------------------------------------------

        if (config.siteName) {

            document.title =
                `${numberOrZero(data.windMs).toFixed(2)} m/s | ${config.siteName}`;

        }


        // --------------------------------------------------------
        // Send event to any other dashboard components
        // --------------------------------------------------------

        window.dispatchEvent(

            new CustomEvent(
                "wind-live-update",
                {
                    detail: data
                }
            )

        );

    }


    // ============================================================
    // PROCESS FIREBASE DATA
    // ============================================================

    function processData(newData) {

        if (!newData)
            return;


        liveData = {

            ...liveData,

            ...newData

        };


        liveData.windMs =
            numberOrZero(
                liveData.windMs
            );


        liveData.windKmh =
            numberOrZero(
                liveData.windKmh
            );


        liveData.windAdcV =
            numberOrZero(
                liveData.windAdcV
            );


        liveData.sensorV =
            numberOrZero(
                liveData.sensorV
            );


        liveData.rawAdc =
            numberOrZero(
                liveData.rawAdc
            );


        liveData.timestamp =
            numberOrZero(
                liveData.timestamp
            );


        window.WIND_LIVE_DATA =
            liveData;


        lastReceivedAt =
            Date.now();


        connected = true;


        setStatus(
            "● LIVE",
            true
        );


        updateDashboard(
            liveData
        );


        console.log(
            "[Firebase LIVE]",
            liveData
        );

    }


    // ============================================================
    // FIREBASE STREAM
    // ============================================================

    function connectFirebase() {

        if (stream) {

            stream.close();

        }


        console.log(
            "[Firebase] Connecting..."
        );


        stream =
            new EventSource(
                config.firebaseLiveUrl
            );


        // --------------------------------------------------------
        // CONNECTION OPENED
        // --------------------------------------------------------

        stream.onopen = () => {

            connected = true;


            console.log(
                "[Firebase] LIVE connection established."
            );


            setStatus(
                "● CONNECTED",
                true
            );

        };


        // --------------------------------------------------------
        // FULL DATA UPDATE
        // --------------------------------------------------------

        stream.addEventListener(
            "put",
            event => {

                try {

                    const message =
                        JSON.parse(
                            event.data
                        );


                    // Root data
                    if (
                        message.path === "/"
                    ) {

                        processData(
                            message.data
                        );

                        return;

                    }


                    // Individual field update
                    const key =
                        message.path
                            .replace(
                                /^\//,
                                ""
                            );


                    if (key) {

                        processData({
                            [key]:
                                message.data
                        });

                    }

                }
                catch (error) {

                    console.error(
                        "[Firebase] PUT parsing error:",
                        error
                    );

                }

            }
        );


        // --------------------------------------------------------
        // PARTIAL DATA UPDATE
        // --------------------------------------------------------

        stream.addEventListener(
            "patch",
            event => {

                try {

                    const message =
                        JSON.parse(
                            event.data
                        );


                    if (
                        message.path === "/"
                    ) {

                        processData(
                            message.data
                        );

                        return;

                    }


                    const key =
                        message.path
                            .replace(
                                /^\//,
                                ""
                            );


                    if (key) {

                        processData({
                            [key]:
                                message.data
                        });

                    }

                }
                catch (error) {

                    console.error(
                        "[Firebase] PATCH parsing error:",
                        error
                    );

                }

            }
        );


        // --------------------------------------------------------
        // STREAM ERROR
        // --------------------------------------------------------

        stream.onerror = error => {

            connected = false;


            console.warn(
                "[Firebase] Connection interrupted.",
                error
            );


            setStatus(
                "● RECONNECTING",
                false
            );


            /*
             * EventSource automatically attempts
             * to reconnect.
             */

        };

    }


    // ============================================================
    // OFFLINE WATCHDOG
    // ============================================================

    function checkDeviceStatus() {

        const offlineAfter =
            config.offlineAfterMs
            || 5000;


        if (
            lastReceivedAt === 0
        ) {

            return;

        }


        const age =
            Date.now()
            - lastReceivedAt;


        if (
            age > offlineAfter
        ) {

            setStatus(
                "● OFFLINE",
                false
            );

        }
        else {

            setStatus(
                "● LIVE",
                true
            );

        }

    }


    // Check every second.
    setInterval(
        checkDeviceStatus,
        1000
    );


    // ============================================================
    // OPTIONAL CONNECTION INFORMATION
    // ============================================================

    window.WIND_FIREBASE = {

        reconnect() {

            connectFirebase();

        },


        disconnect() {

            if (stream) {

                stream.close();

            }


            connected = false;


            setStatus(
                "● DISCONNECTED",
                false
            );

        },


        isConnected() {

            return connected;

        },


        getLatestData() {

            return {
                ...liveData
            };

        }

    };


    // ============================================================
    // START
    // ============================================================

    connectFirebase();


})();