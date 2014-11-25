{
  "targets": [
    {
      "target_name": "phplikeCppCurl",
      "sources": [ 
          "util.cc",
          "phplikeCppCurl.cc"
      ],
      "cflags": ["-std=gnu++0x"],
      "cflags_cc": ["-fexceptions"],
      "type": "shared_library",
      "libraries": [
          '-lcurl'
      ],
      "defines": [
        "LINUX_DEFINE"
      ],
      "include_dirs": [
        "include/linux"
      ]

    }
  ]
}
