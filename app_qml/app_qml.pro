QT += core gui qml quick
CONFIG += c++17
TEMPLATE = app
TARGET = StrongholdLink

win32:CONFIG += windows

SOURCES += \
    main.cpp \
    backendbridge.cpp

HEADERS += \
    backendbridge.h

RESOURCES += qml.qrc

# 只让源码树内的 QML 进资源；构建产物不入包。
DISTFILES += qml/theme.js
