using ACadSharp.IO;

if (args.Length != 3 || (args[0] != "read" && args[0] != "write"))
{
    Console.Error.WriteLine("Specify read or write, an input file, and an output file.");
    return 1;
}

try
{
    if (args[0] == "read")
    {
        using var reader = new DwgReader(args[1]);
        using var writer = new DxfWriter(args[2], reader.Read());
        writer.Write();
    }
    else
    {
        using var reader = new DxfReader(args[1]);
        using var writer = new DwgWriter(args[2], reader.Read());
        writer.Write();
    }
    return 0;
}
catch (Exception error)
{
    Console.Error.WriteLine(error.Message);
    return 1;
}
